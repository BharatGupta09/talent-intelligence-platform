import { type NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Coarse route gate.
 *
 * This is a convenience layer ONLY. It is not a security boundary: middleware
 * runs before the request reaches any handler and can be bypassed by calling
 * an API route directly. Real enforcement is RLS plus the guards in
 * lib/auth/guards.ts, both of which run regardless of what happens here.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * This used to call supabase.auth.getUser(), which meant a network round trip
 * to Supabase on nearly every request — and when that backend became
 * unreachable the middleware hung until it timed out, taking the whole site
 * down with it. Verifying the cookie signature locally has no network
 * dependency at all, so a database outage can no longer stop pages rendering.
 */

const SESSION_COOKIE = 'tip_session';
const ISSUER = 'talent-intelligence-platform';

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;

  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw || raw.length < 32) {
    // Misconfigured rather than unauthenticated. Fail closed for protected
    // routes; the guards will produce the real error.
    return false;
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(raw), { issuer: ISSUER });
    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = ['/candidate', '/recruiter', '/admin'].some((p) =>
    path.startsWith(p),
  );

  if (isProtected && !(await hasValidSession(request))) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
