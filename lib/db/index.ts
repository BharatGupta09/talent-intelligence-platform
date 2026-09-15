import 'server-only';
import { QueryBuilder, type Runner } from './builder';
import { runAsUser, runAsService } from './session';

export type { Result, PgError } from './builder';
export { runAsUser, runAsService, runAuthOp, assertUserId } from './session';
export { getPool } from './pool';

/**
 * The data client.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * Shaped like the supabase-js client on purpose — it exposes `.from(table)`
 * and nothing else — so the 154 existing call sites keep working unchanged.
 * What differs is underneath: every query runs inside its own transaction
 * carrying `SET LOCAL app.user_id`, which is what keeps the RLS policies
 * authoritative now that Supabase is no longer supplying auth.uid().
 */
export interface DataClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<Row = any>(table: string): QueryBuilder<Row>;
}

function clientFor(run: Runner): DataClient {
  return {
    from<Row>(table: string) {
      return new QueryBuilder<Row>(run, table);
    },
  };
}

/**
 * A client bound to one signed-in user, or to nobody.
 *
 * Passing null is the anonymous case: `app_user_id()` resolves to NULL and
 * every policy fails closed, which is how the public job board reads only
 * `status = 'active'` rows without any filtering in application code.
 */
export function dataClient(userId: string | null): DataClient {
  return clientFor((fn) => runAsUser(userId, fn));
}

/**
 * A client that escapes RLS, for background work only.
 * Replaces the Supabase service-role client. See runAsService().
 */
export function serviceClient(): DataClient {
  return clientFor((fn) => runAsService(fn));
}
