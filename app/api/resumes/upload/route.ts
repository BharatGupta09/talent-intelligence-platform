import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCandidateId, errorResponse } from '@/lib/auth/guards';
import { validateUpload, PdfError, PDF_ERROR_COPY } from '@/lib/resume/pdf';
import { presignUpload, resumeKey, RESUME_CONTENT_TYPE } from '@/lib/storage/r2';

export const runtime = 'nodejs';

/**
 * Step 1 of resume upload: hand back a presigned URL.
 *
 * MIGRATION NOTE (Supabase Storage -> R2):
 * The file used to be posted here and forwarded to storage. It no longer
 * passes through this function at all, for a concrete reason: a Vercel
 * function rejects request bodies over 4.5 MB, while the product accepts
 * resumes up to 5 MB. Routing the bytes through the server would have meant
 * either a 413 on large files or cutting the documented limit. The browser
 * now PUTs straight to R2 and calls /api/resumes/confirm afterwards.
 *
 * The presigned URL pins bucket, key, content type and content length, so it
 * cannot be reused to store a different or larger object. The key is
 * namespaced by user id, exactly as before.
 */
const Body = z.object({
  fileName: z.string().trim().min(1).max(200),
  fileSize: z.number().int().positive(),
  contentType: z.string().trim().max(120),
});

export async function POST(request: Request) {
  try {
    const { user } = await requireCandidateId();

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'No file details were received.' }, { status: 400 });
    }
    const { fileName, fileSize, contentType } = parsed.data;

    // Same validation as before, now against the declared metadata. The
    // confirm step re-checks the stored object's real size, so a client that
    // lies here gains nothing.
    try {
      validateUpload({ name: fileName, size: fileSize, type: contentType });
    } catch (err) {
      if (err instanceof PdfError) {
        return NextResponse.json(
          { error: PDF_ERROR_COPY[err.code], code: err.code }, { status: 400 },
        );
      }
      throw err;
    }

    const resumeId = crypto.randomUUID();
    const key = resumeKey(user.id, resumeId);
    const uploadUrl = await presignUpload(key, fileSize);

    return NextResponse.json({
      resumeId,
      uploadUrl,
      contentType: RESUME_CONTENT_TYPE,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
