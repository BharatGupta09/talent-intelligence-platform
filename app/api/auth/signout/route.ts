import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth/session';

export const runtime = 'nodejs';

/**
 * MIGRATION NOTE: replaces supabase.auth.signOut(). Clearing the cookie is the
 * whole operation — there is no remote session to revoke.
 */
export async function POST(request: Request) {
  await clearSessionCookie();
  return NextResponse.redirect(new URL('/', request.url), { status: 303 });
}
