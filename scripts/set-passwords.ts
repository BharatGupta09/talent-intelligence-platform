/**
 * Rotates the demo account passwords and prints them once.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/set-passwords.ts
 *
 * MIGRATION NOTE (Supabase -> Neon): this used the Supabase admin API to set
 * passwords. It now goes through lib/auth, which is the only code permitted to
 * touch the credential store, and reads the account list through the service
 * client. Nothing here logs a hash.
 */
import { randomBytes } from 'node:crypto';
import { serviceClient } from '../lib/db';
import { setPassword } from '../lib/auth/users';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  console.error('Run with:  npx tsx --conditions=react-server --env-file=.env.local scripts/set-passwords.ts');
  process.exit(1);
}

const db = serviceClient();

/** URL-safe, no ambiguous characters, ~128 bits of entropy. */
function generate(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(22);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  console.log('\nResolving demo accounts…');

  const { data: profiles, error } = await db
    .from('profiles')
    .select('id, email, role, full_name')
    .order('role');

  if (error) {
    console.error('Could not read profiles:', error.message);
    process.exit(1);
  }

  const demo = (profiles ?? []).filter((p: { email: string }) =>
    p.email.endsWith('@demo.internal'));

  if (demo.length === 0) {
    console.error('No @demo.internal accounts found. Run the seed first.');
    process.exit(1);
  }

  console.log('\nNew passwords — copy these now, they are not stored anywhere:\n');
  for (const p of demo as { email: string; role: string; full_name: string }[]) {
    const password = generate();
    const ok = await setPassword(p.email, password);
    if (!ok) {
      console.error(`  FAILED  ${p.email}`);
      continue;
    }
    console.log(`  ${p.role.padEnd(10)} ${p.email.padEnd(30)} ${password}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
