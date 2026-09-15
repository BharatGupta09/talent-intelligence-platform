import 'server-only';
import type { PoolClient } from '@neondatabase/serverless';
import { getPool } from './pool';

/**
 * Transaction-scoped request identity.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * Supabase populated `auth.uid()` from the request JWT. Nothing does that on
 * Neon, so the application supplies identity itself:
 *
 *     BEGIN;
 *     SET LOCAL app.user_id = '<uuid>';
 *     ...statements...
 *     COMMIT;
 *
 * `SET LOCAL` is the whole point. It is scoped to the transaction, so when the
 * connection returns to the pool the setting is gone. A session-level `SET`
 * would survive, and the next request to borrow that connection would run as
 * the previous user — a cross-tenant data leak. Never change this to `SET`.
 *
 * `runAsUser(null, ...)` runs with no identity at all: `app_user_id()` returns
 * NULL and every policy fails closed, which is exactly what an anonymous
 * request should get.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects anything that is not a plain UUID before it can reach SQL. */
export function assertUserId(id: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error('Refusing to set a request identity that is not a UUID.');
  }
  return id;
}

export type Tx = PoolClient;

async function withTransaction<T>(
  setup: (client: PoolClient) => Promise<void>,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; releasing it is all we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `body` inside one transaction carrying the given identity.
 * Pass null for an unauthenticated request.
 */
export function runAsUser<T>(
  userId: string | null,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    if (userId !== null) {
      // Parameterised: the value is never concatenated into SQL. set_config
      // with is_local = true is the function form of SET LOCAL.
      await client.query('select set_config($1, $2, true)', [
        'app.user_id',
        assertUserId(userId),
      ]);
    }
  }, body);
}

/**
 * Runs `body` with the authentication escape hatch enabled.
 *
 * The `users` table denies every read unless `app.auth_op` is set, so only the
 * sign-in and registration paths can reach credentials. Like identity, the
 * flag is transaction-scoped and cannot outlive the statement group.
 *
 * Nothing outside lib/auth may call this.
 */
export function runAuthOp<T>(
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.auth_op', 'on']);
  }, body);
}

/**
 * Runs `body` with RLS escaped, for background/system work only.
 *
 * MIGRATION NOTE: this is the replacement for Supabase's service-role key. It
 * is deliberately a transaction-scoped GUC rather than a second connection
 * with elevated rights, so the escape is visible in the same place as every
 * other identity decision and cannot outlive the transaction.
 *
 * Callers: the AI queue drain and admin tooling. Nothing that serves a user
 * request may call this.
 */
export function runAsService<T>(
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.service_op', 'on']);
  }, body);
}
