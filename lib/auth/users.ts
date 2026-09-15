import 'server-only';
import { runAuthOp } from '@/lib/db/session';
import { hashPassword, verifyPassword } from './password';

/**
 * The credential path.
 *
 * MIGRATION NOTE: replaces Supabase Auth's signInWithPassword and the
 * `handle_new_user` trigger that fired on the managed auth table. Both now
 * live here, in explicit transactions.
 *
 * Everything in this module runs through runAuthOp(), the only code permitted
 * to read `users`. Nothing here returns a password hash to a caller.
 */

export type Role = 'candidate' | 'recruiter' | 'admin';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  isActive: boolean;
}

/**
 * Verifies an email/password pair.
 *
 * Returns null for: unknown email, wrong password, and deactivated account —
 * deliberately the same answer, so sign-in cannot be used to discover which
 * addresses are registered or which accounts have been disabled.
 *
 * The password is always hashed against something. When the email is unknown
 * we verify against a dummy hash so the response time does not reveal whether
 * the account exists.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAA==';

export async function authenticate(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const normalised = String(email ?? '').trim().toLowerCase();
  if (!normalised || typeof password !== 'string' || password.length === 0) {
    return null;
  }

  const row = await runAuthOp(async (client) => {
    const res = await client.query(
      `select u.id, u.email, u.password_hash,
              p.role, p.full_name, p.is_active
         from users u
         join profiles p on p.id = u.id
        where u.email = $1
        limit 1`,
      [normalised],
    );
    return res.rows[0] as
      | {
          id: string; email: string; password_hash: string;
          role: Role; full_name: string; is_active: boolean;
        }
      | undefined;
  });

  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok || !row.is_active) return null;

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name ?? '',
    isActive: row.is_active,
  };
}

/**
 * Creates a user, their profile, and — for candidates — their candidate
 * profile, in one transaction.
 *
 * MIGRATION NOTE: this is the `handle_new_user()` trigger, moved into
 * application code. The trigger fired on the managed auth table, which no
 * longer exists. Doing it in an explicit transaction keeps the same
 * all-or-nothing guarantee and makes the role assignment testable.
 */
export async function registerUser(input: {
  email: string;
  password: string;
  fullName?: string;
  role?: Role;
}): Promise<{ id: string } | { error: string }> {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) return { error: 'A valid email address is required.' };
  if (!input.password || input.password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  const role: Role = input.role ?? 'candidate';
  const passwordHash = await hashPassword(input.password);

  try {
    return await runAuthOp(async (client) => {
      const inserted = await client.query(
        `insert into users (email, password_hash) values ($1, $2)
         on conflict (email) do nothing
         returning id`,
        [email, passwordHash],
      );
      if (inserted.rows.length === 0) {
        return { error: 'That email address is already registered.' };
      }
      const id = inserted.rows[0].id as string;

      await client.query(
        `insert into profiles (id, email, full_name, role)
         values ($1, $2, $3, $4)
         on conflict (id) do nothing`,
        [id, email, input.fullName ?? '', role],
      );

      if (role === 'candidate') {
        await client.query(
          `insert into candidate_profiles (user_id) values ($1)
           on conflict (user_id) do nothing`,
          [id],
        );
      }
      return { id };
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Replaces a user's password. Used by scripts/set-passwords.ts. */
export async function setPassword(email: string, password: string): Promise<boolean> {
  const normalised = String(email ?? '').trim().toLowerCase();
  const hash = await hashPassword(password);
  return runAuthOp(async (client) => {
    const res = await client.query(
      'update users set password_hash = $2 where email = $1',
      [normalised, hash],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
