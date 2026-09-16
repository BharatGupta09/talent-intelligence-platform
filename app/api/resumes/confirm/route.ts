import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCandidateId, errorResponse } from '@/lib/auth/guards';
import { createClient } from '@/lib/db/server';
import { enqueue } from '@/lib/ai/service';
import {
  extractPdfText, checksum, PdfError, PDF_ERROR_COPY, MAX_RESUME_BYTES,
} from '@/lib/resume/pdf';
import { objectSize, getObjectBytes, deleteObject, resumeKey } from '@/lib/storage/r2';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Step 2 of resume upload: the object is in R2, record and process it.
 *
 * The ordering from the original implementation is preserved, and it still
 * matters: the row is created before extraction is attempted, so a failed
 * extraction leaves the candidate with their file and a row explaining why.
 * Nothing is silently discarded.
 *
 * MIGRATION NOTE: the key is derived server-side from the authenticated user
 * id and the supplied resume id — it is never taken from the request body.
 * A candidate therefore cannot confirm an object sitting under someone else's
 * prefix.
 */
const Body = z.object({
  resumeId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const { user, candidateId } = await requireCandidateId();

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Upload could not be confirmed.' }, { status: 400 });
    }
    const { resumeId, fileName } = parsed.data;
    const key = resumeKey(user.id, resumeId);

    // The object must actually exist, and must be within the limit. This is
    // the authoritative size check: the presign step only saw a claim.
    const size = await objectSize(key);
    if (size === null) {
      return NextResponse.json(
        { error: 'The uploaded file was not found. Please try again.' }, { status: 404 },
      );
    }
    if (size === 0 || size > MAX_RESUME_BYTES) {
      await deleteObject(key);
      return NextResponse.json(
        { error: PDF_ERROR_COPY[size === 0 ? 'empty_file' : 'too_large'] },
        { status: 400 },
      );
    }

    const db = await createClient();
    const bytes = await getObjectBytes(key);
    const hash = await checksum(bytes);

    // Retire the previous active resume. The partial unique index allows only
    // one active row per candidate, so this must happen before insert.
    await db.from('resumes')
      .update({ is_active: false }).eq('candidate_id', candidateId).eq('is_active', true);

    const { data: resume, error: insertError } = await db
      .from('resumes')
      .insert({
        id: resumeId,
        candidate_id: candidateId,
        storage_path: key,
        file_name: fileName.slice(0, 200),
        file_size: size,
        checksum: hash,
        status: 'uploaded',
        is_active: true,
      })
      .select('id')
      .single();

    if (insertError || !resume) {
      // Roll back the orphaned object so storage does not drift from the DB.
      await deleteObject(key);
      return NextResponse.json(
        { error: 'Your resume could not be saved. Please try again.' }, { status: 500 },
      );
    }

    // Extraction. A failure here degrades the row but never deletes it.
    try {
      const extracted = await extractPdfText(bytes);
      await db.from('resumes').update({
        extracted_text: extracted.text,
        page_count: extracted.pageCount,
        status: 'queued',
        extraction_error: null,
      }).eq('id', resume.id);

      await enqueue('resume_analysis', resume.id);

      return NextResponse.json({
        id: resume.id,
        status: 'queued',
        pageCount: extracted.pageCount,
        message: 'Resume uploaded. Analysis is running.',
      });
    } catch (err) {
      const code = err instanceof PdfError ? err.code : 'malformed';
      const message = PDF_ERROR_COPY[code] ?? PDF_ERROR_COPY.malformed;

      await db.from('resumes').update({
        status: 'requires_review',
        extraction_error: message,
      }).eq('id', resume.id);

      // 200, not an error status: the upload itself succeeded and the file is
      // safe. The client renders the recoverable state.
      return NextResponse.json({
        id: resume.id, status: 'requires_review', code, message,
      });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
