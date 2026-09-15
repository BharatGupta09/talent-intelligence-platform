import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * MIGRATION NOTE: Supabase hashed passwords for us. scrypt from node:crypto
 * replaces that — memory-hard, in the standard library, and available on
 * Vercel's Node runtime, so no native module and no extra dependency.
 *
 * The cost parameters are stored inside the encoded hash, so they can be
 * raised later without invalidating existing credentials.
 */

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom over the default.
const MAXMEM = 64 * 1024 * 1024;

/** Encodes as  scrypt$N$r$p$<salt b64>$<hash b64>  */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns false for malformed stored values
 * rather than throwing, so a corrupt row cannot become an exception path that
 * behaves differently from a wrong password.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: n, r, p, maxmem: MAXMEM,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
