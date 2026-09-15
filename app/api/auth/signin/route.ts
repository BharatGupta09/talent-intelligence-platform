import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticate } from '@/lib/auth/users';
import { setSessionCookie } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign in.
 *
 * MIGRATION NOTE: replaces supabase.auth.signInWithPassword(), which ran in
 * the browser. Credentials now go to the server, are verified against the
 * scrypt hash, and the session is issued as an httpOnly cookie the browser
 * cannot read.
 *
 * Every failure returns the same message and the same status. Unknown email,
 * wrong password and deactivated account are indistinguishable, so this
 * endpoint cannot be used to enumerate accounts.
 */
const Body = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(512),
});

const FAILED = { error: 'That email and password combination was not recognised.' };

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json(FAILED, { status: 401 });
  }
  if (!parsed.success) return NextResponse.json(FAILED, { status: 401 });

  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) return NextResponse.json(FAILED, { status: 401 });

  await setSessionCookie(user.id);
  return NextResponse.json({ ok: true });
}
