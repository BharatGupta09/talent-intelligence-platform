import 'server-only';
import { serviceClient, type DataClient } from '@/lib/db';

/**
 * Service client. BYPASSES RLS.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * This used to be the service-role key, which bypassed RLS at the PostgREST
 * layer. Neon has no such key. The replacement runs each query inside a
 * transaction that sets `app.service_op`, which the `*_svc` policies in
 * 0002_rls.sql accept. Same effect, but the escape is transaction-scoped,
 * visible in SQL, and cannot leak onto a pooled connection.
 *
 * Permitted callers only:
 *   - the AI worker, which must write analyses on behalf of the system
 *   - seed scripts
 *   - admin routes that have ALREADY verified the caller is an admin
 *
 * Never construct this in response to unvalidated user input, and never
 * import it into a Client Component. The `server-only` import above turns
 * any such attempt into a build error.
 */
export function createAdminClient(): DataClient {
  return serviceClient();
}
