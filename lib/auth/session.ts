import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

/**
 * Session tokens.
 *
 * MIGRATION NOTE: replaces Supabase Auth's cookie session. An HS256 JWT in an
 * httpOnly cookie, signed with a server-only secret. The token carries the
 * user id and nothing that matters for authorization — role and active status
 * are read from the database on every request, so deactivating a user or
 * changing their role takes effect immediately rather than at token expiry.
 */

export const SESSION_COOKIE = 'tip_session';
const ISSUER = 'talent-intelligence-platform';
const MAX_AGE_SECONDS = 60 * 60 * 8; // one working day

function secret(): Uint8Array {
  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'AUTH_JWT_SECRET is missing or too short (needs at least 32 characters).',
    );
  }
  return new TextEncoder().encode(raw);
}

export interface SessionClaims {
  sub: string;
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

/** Returns the claims, or null for anything invalid, expired or absent. */
export async function verifySessionToken(
  token: string | undefined,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER });
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) return null;
    return { sub };
  } catch {
    // Expired, tampered, wrong issuer, wrong algorithm — all the same answer.
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Secure is required in production; omitted locally so http://localhost works.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionToken(userId), cookieOptions());
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}

/** The signed-in user's id for this request, or null. Never throws. */
export async function currentUserId(): Promise<string | null> {
  try {
    const store = await cookies();
    const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
    return claims?.sub ?? null;
  } catch {
    return null;
  }
}
