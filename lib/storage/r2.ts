import 'server-only';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2, via the S3-compatible API.
 *
 * MIGRATION NOTE (Supabase Storage -> R2):
 * The application host is Vercel, not a Cloudflare Worker, so there is no R2
 * binding available. This talks to R2 over plain HTTPS with an S3 client and
 * an R2 API token, which works from any Node runtime.
 *
 * The bucket is private. Nothing here ever returns a public URL, and the
 * credentials live only in server-side environment variables — the browser
 * receives presigned URLs with a short expiry and nothing else.
 *
 * Object keys keep the original convention: {userId}/{resumeId}.pdf
 */

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes, matching the previous behaviour
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const RESUME_CONTENT_TYPE = 'application/pdf';

declare global {
  // eslint-disable-next-line no-var
  var __tipR2: S3Client | undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function bucket(): string {
  return required('R2_BUCKET');
}

export function r2(): S3Client {
  if (!globalThis.__tipR2) {
    const accountId = required('R2_ACCOUNT_ID');
    globalThis.__tipR2 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    });
  }
  return globalThis.__tipR2;
}

/** {userId}/{resumeId}.pdf — unchanged from the Supabase Storage layout. */
export function resumeKey(userId: string, resumeId: string): string {
  return `${userId}/${resumeId}.pdf`;
}

/**
 * A short-lived URL the browser can PUT the file to directly.
 *
 * This is what keeps uploads working at the product's 5 MB limit: a Vercel
 * function caps request bodies at 4.5 MB, so routing the bytes through the
 * server would reject large resumes. Going straight to R2 avoids that path
 * entirely. The content type and length are pinned into the signature, so the
 * URL cannot be reused to store something else.
 */
export function presignUpload(key: string, contentLength: number): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: RESUME_CONTENT_TYPE,
      ContentLength: contentLength,
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}

/** A short-lived read URL. Callers must authorize first. */
export function presignDownload(key: string, filename?: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ...(filename
        ? { ResponseContentDisposition: `inline; filename="${filename.replace(/"/g, '')}"` }
        : {}),
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}

/** Byte size of a stored object, or null when it does not exist. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await r2().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch {
    return null;
  }
}

/** Server-side fetch of the object bytes, for PDF extraction. */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await r2().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) {
    throw new Error('R2 returned no readable body.');
  }
  return body.transformToByteArray();
}

/** Used to roll back an orphaned object when the database write fails. */
export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
