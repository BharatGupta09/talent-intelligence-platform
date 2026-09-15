/**
 * Provisions the least-privilege application role.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/db-setup-role.ts
 *
 * WHY THIS EXISTS
 * Neon hands you `neondb_owner`, and that role carries the BYPASSRLS
 * attribute. BYPASSRLS overrides row-level security unconditionally —
 * including FORCE ROW LEVEL SECURITY. Connecting the application as the owner
 * therefore makes every policy in 0002_rls.sql inert: every user sees every
 * row, silently, with no error anywhere.
 *
 * That is not a theoretical risk. It was observed: a recruiter read another
 * recruiter's applications while owns_application() correctly returned false,
 * because the policy was never consulted.
 *
 * The fix mirrors what Supabase did. Supabase's `authenticated` role was not
 * the table owner and did not bypass RLS; only the service key bypassed. Here:
 *
 *   neondb_owner  -> migrations only (DDL), keeps BYPASSRLS
 *   tip_app       -> the application, NOBYPASSRLS, subject to every policy
 *
 * The generated password is written only into .env.local, which is git-ignored,
 * and is never printed.
 *
 * Re-running is safe: the role is created if absent, its password rotated, and
 * grants re-applied (needed whenever a migration adds tables).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client, neonConfig } from '@neondatabase/serverless';

if (typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

const ROLE = 'tip_app';
const ENV = '.env.local';

/** Alphanumeric only, so it needs no escaping inside a connection URI. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(randomBytes(40), (b) => alphabet[b % alphabet.length]).join('');
}

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function writeEnv(env: Record<string, string>) {
  const order = [
    'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_URL_OWNER',
    'AUTH_JWT_SECRET', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY', 'GROQ_API_KEY', 'GROQ_MODEL',
    'AI_WORKER_SECRET', 'CRON_SECRET',
  ];
  const keys = [...order.filter((k) => k in env), ...Object.keys(env).filter((k) => !order.includes(k))];
  writeFileSync(ENV, keys.map((k) => `${k}=${env[k]}`).join('\n') + '\n', 'utf8');
}

/** Swaps the user:password in a postgres URI, leaving everything else intact. */
function withRole(uri: string, role: string, password: string): string {
  return uri.replace(/^(postgres(?:ql)?:\/\/)[^@]*@/, `$1${role}:${password}@`);
}

async function main() {
  const env = readEnv();
  // The owner URI is whatever currently has DDL rights. On first run that is
  // DATABASE_URL_UNPOOLED; afterwards it is preserved as DATABASE_URL_OWNER.
  const ownerUri = env.DATABASE_URL_OWNER ?? env.DATABASE_URL_UNPOOLED;
  if (!ownerUri) throw new Error('No owner connection string available.');

  const password = generatePassword();
  const client = new Client({ connectionString: ownerUri });
  await client.connect();

  try {
    const me = await client.query('select current_user as usr');
    console.log(`  connected as ${me.rows[0].usr} (owner connection)`);

    // CREATE ROLE cannot take bind parameters, so the password is interpolated.
    // It is generated from a strict alphanumeric alphabet and asserted here, so
    // it cannot contain a quote, backslash or anything else that could escape
    // the literal. The role name is a compile-time constant.
    if (!/^[A-Za-z0-9]{32,}$/.test(password)) {
      throw new Error('Generated password failed its own safety check.');
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) {
      throw new Error('Role name is not a safe identifier.');
    }

    const exists = await client.query('select 1 from pg_roles where rolname = $1', [ROLE]);
    if (exists.rowCount === 0) {
      await client.query(
        `create role ${ROLE} login password '${password}' ` +
        `nosuperuser nocreatedb nocreaterole nobypassrls`);
      console.log(`  role ${ROLE} created`);
    } else {
      await client.query(
        `alter role ${ROLE} with login password '${password}' nobypassrls`);
      console.log(`  role ${ROLE} already existed — password rotated`);
    }

    // Privileges: enough to run the application, nothing more. No CREATE on the
    // schema, so the application cannot alter its own security model.
    await client.query(`grant usage on schema public to ${ROLE}`);
    await client.query(`grant select, insert, update, delete on all tables in schema public to ${ROLE}`);
    await client.query(`grant usage, select on all sequences in schema public to ${ROLE}`);
    await client.query(`grant execute on all functions in schema public to ${ROLE}`);
    await client.query(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${ROLE}`);
    await client.query(
      `alter default privileges in schema public grant usage, select on sequences to ${ROLE}`);
    console.log('  privileges granted (no CREATE, no DDL)');

    const attrs = await client.query(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = $1`, [ROLE]);
    const a = attrs.rows[0];
    console.log(`  verified: super=${a.rolsuper} bypassrls=${a.rolbypassrls} createdb=${a.rolcreatedb} createrole=${a.rolcreaterole}`);
    if (a.rolbypassrls) throw new Error(`${ROLE} has BYPASSRLS — refusing to continue.`);

    // Rewrite the environment so the application connects as the new role and
    // the owner connection is retained for migrations only.
    env.DATABASE_URL_OWNER = ownerUri;
    env.DATABASE_URL = withRole(env.DATABASE_URL, ROLE, password);
    env.DATABASE_URL_UNPOOLED = withRole(env.DATABASE_URL_UNPOOLED, ROLE, password);
    writeEnv(env);
    console.log('  .env.local updated: application now connects as the least-privilege role');
    console.log('  DATABASE_URL_OWNER retained for migrations (DDL) only');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('  ROLE SETUP FAILED:', (e as Error).message);
  process.exit(1);
});
