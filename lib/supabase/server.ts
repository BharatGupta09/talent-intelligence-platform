import 'server-only';
import { dataClient, type DataClient } from '@/lib/db';
import { currentUserId } from '@/lib/auth/session';

/**
 * Request-scoped data client running as the SIGNED-IN USER.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * The module path and the `createClient()` signature are unchanged so the
 * ~50 files that import this keep working untouched. What changed is the
 * implementation: instead of a PostgREST client carrying a JWT, this resolves
 * the session cookie and hands back a client that runs every query inside
 * `BEGIN; SET LOCAL app.user_id = ...; COMMIT`.
 *
 * Every query through this client is still subject to RLS — that is
 * deliberate, and unchanged from before. Use it for all normal reads and
 * writes. An unauthenticated request resolves to null identity, which makes
 * `app_user_id()` NULL and every policy fail closed.
 */
export async function createClient(): Promise<DataClient> {
  return dataClient(await currentUserId());
}
