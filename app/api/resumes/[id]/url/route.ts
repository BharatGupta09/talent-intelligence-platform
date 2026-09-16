import { NextResponse } from 'next/server';
import { requireUser, errorResponse, AuthzError } from '@/lib/auth/guards';
import { createClient } from '@/lib/db/server';
import { presignDownload } from '@/lib/storage/r2';

export const runtime = 'nodejs';

/**
 * Short-lived signed URL for viewing an original resume PDF (§45).
 *
 * Authorization is not re-implemented here: the read below runs as the
 * signed-in user, so RLS decides whether this resume is visible at all.
 * A recruiter reaches a resume only via `resumes_recruiter_read`, which
 * requires an application to a job they own.
 *
 * MIGRATION NOTE: the URL is now presigned against R2 instead of Supabase
 * Storage. The authorization model is unchanged — the database decides, and
 * a row the caller cannot see yields a 404 identical to a row that does not
 * exist, so resume ids cannot be probed.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const db = await createClient();

    const { data: resume } = await db
      .from('resumes').select('id, storage_path, file_name').eq('id', id).maybeSingle();

    if (!resume) throw new AuthzError(404, 'Resume not found.');

    try {
      const url = await presignDownload(resume.storage_path, resume.file_name);
      return NextResponse.json({ url, fileName: resume.file_name });
    } catch {
      return NextResponse.json({ error: 'The resume file could not be opened.' }, { status: 502 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
