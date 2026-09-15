/**
 * Applies db/migrations/*.sql to a PostgreSQL database.
 *
 *   npx tsx --env-file=.env.local scripts/db-migrate.ts [--force]
 *
 * Uses DATABASE_URL_OWNER (the direct owner connection). Schema changes must not
 * go through the pooler: PgBouncer in transaction mode cannot hold the session
 * state some DDL relies on, and a migration is exactly the case where you want
 * one uninterrupted session.
 *
 * Each file is sent as a single query. node-postgres' simple query protocol
 * runs a multi-statement string in one implicit transaction, so a failure
 * anywhere rolls the whole file back — and, importantly, it avoids splitting
 * SQL on semicolons, which would corrupt the dollar-quoted `do $$ ... $$`
 * blocks and function bodies these migrations rely on.
 *
 * Refuses to run against a database that already has application tables unless
 * --force is passed, so it cannot silently clobber a populated database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, neonConfig } from '@neondatabase/serverless';

if (typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

const force = process.argv.includes('--force');
const dir = join(import.meta.dirname, '..', 'db', 'migrations');

function connectionString(): string {
  // DDL needs the owner. DATABASE_URL/_UNPOOLED belong to the least-privilege
  // application role, which deliberately cannot create or alter tables.
  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (owner connection required for DDL).');
  return url;
}

async function main() {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No .sql files in ${dir}`);

  const client = new Client({ connectionString: connectionString() });
  await client.connect();

  try {
    const existing = await client.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const n = existing.rows[0].n as number;
    console.log(`  target database currently has ${n} public table(s)`);

    if (n > 0 && !force) {
      console.error(
        '  REFUSING: the database is not empty. Re-run with --force only if you are ' +
        'certain this is the dedicated migration-test database.',
      );
      process.exitCode = 1;
      return;
    }

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const started = Date.now();
      process.stdout.write(`  applying ${file} ... `);
      await client.query(sql);
      console.log(`ok (${Date.now() - started} ms)`);
    }

    const after = await client.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    console.log(`  done. public tables now: ${after.rows[0].n}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  // Surface the real PostgreSQL error rather than a generic failure.
  const pg = e as { message?: string; position?: string; hint?: string; detail?: string };
  console.error('  MIGRATION FAILED');
  console.error('   message:', pg.message);
  if (pg.detail) console.error('   detail :', pg.detail);
  if (pg.hint) console.error('   hint   :', pg.hint);
  if (pg.position) console.error('   position:', pg.position);
  process.exit(1);
});
