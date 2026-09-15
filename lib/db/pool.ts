import 'server-only';
import { Pool, neonConfig, types } from '@neondatabase/serverless';

/**
 * Neon connection pool.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * This replaces the PostgREST transport that @supabase/ssr used. Queries now
 * go straight to Postgres over a pooled connection, which is what makes
 * transaction-scoped identity (`SET LOCAL app.user_id`) possible — and that,
 * in turn, is what lets the RLS policies survive the migration unchanged.
 *
 * The pool is module-scoped so a warm serverless instance reuses connections
 * rather than opening one per request.
 */

// Neon's Pool speaks WebSocket. Node 22+ (Vercel's runtime) exposes a global
// constructor, so no `ws` dependency is needed. Assigning it explicitly keeps
// the failure mode obvious if that ever stops being true.
if (typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

/**
 * NUMERIC arrives as a JavaScript number, not a string.
 *
 * MIGRATION NOTE: node-postgres decodes `numeric` (OID 1700) as a string by
 * default, to avoid losing precision on values wider than a float64. PostgREST
 * did not do that — it emitted JSON numbers — so every caller in this codebase
 * is written against numbers (`overall: number`, `years_experience: number`).
 *
 * Without this, the same column would arrive as two different types depending
 * on how it was read: a string when selected directly, but a number when read
 * through an embedded resource, because jsonb_build_object produces a real JSON
 * number. That inconsistency is worse than either choice on its own.
 *
 * Safe here because every numeric column in this schema is small and bounded:
 *   application_scores.overall        numeric(5,2)
 *   candidate_profiles.years_experience numeric(4,1)
 *   jobs.experience_min / experience_max numeric(4,1)
 * All are represented exactly by a float64. Adding a wide numeric column later
 * (money, large counters) would require revisiting this.
 */
types.setTypeParser(1700, (value: string) => Number(value));

declare global {
  // eslint-disable-next-line no-var
  var __tipPool: Pool | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the Neon *pooled* connection string.',
    );
  }
  return url;
}

/**
 * Single shared pool, cached on globalThis so Next.js dev's module reloading
 * does not leak a new pool on every edit.
 */
export function getPool(): Pool {
  if (!globalThis.__tipPool) {
    if (typeof globalThis.WebSocket === 'undefined') {
      throw new Error(
        'No global WebSocket. @neondatabase/serverless needs one; run on Node 22+ ' +
        'or set neonConfig.webSocketConstructor explicitly.',
      );
    }
    globalThis.__tipPool = new Pool({
      connectionString: connectionString(),
      // Neon's free tier scales to zero after five minutes of inactivity.
      // Keep the pool small and release idle connections rather than holding
      // one open against a compute that is about to suspend.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return globalThis.__tipPool;
}
