import 'server-only';
import { dataClient, type DataClient } from './index';
import { currentUserId } from '@/lib/auth/session';

/**
 * Request-scoped data client running as the SIGNED-IN USER.
 *
 * This is the client nearly every page and route handler should use. It
 * resolves the session cookie and hands back a client that runs each query
 * inside `BEGIN; SET LOCAL app.user_id = ...; COMMIT`, so the RLS policies in
 * 0002_rls.sql decide what the request can see.
 *
 * An unauthenticated request resolves to a null identity, which makes
 * `app_user_id()` NULL and every policy fail closed. That is what lets the
 * public job board read only `status = 'active'` rows with no filtering in
 * application code.
 *
 * MIGRATION NOTE: this replaced the Supabase server client. The exported
 * `createClient()` signature was deliberately preserved so the ~50 call sites
 * did not have to change during the migration; only the module path moved,
 * once the Supabase directory name had outlived its purpose.
 */
export async function createClient(): Promise<DataClient> {
  return dataClient(await currentUserId());
}
