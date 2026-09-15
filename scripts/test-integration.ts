/**
 * Integration suite — runs against a REAL PostgreSQL database.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/test-integration.ts
 *
 * Everything else in this repository's test suite is static or fake-runner
 * driven. This is the one that actually executes: it validates the migrated
 * schema against the catalog, then exercises the real application modules
 * (lib/db, lib/auth) against a live server.
 *
 * It deliberately uses the application's own entry points — dataClient(),
 * serviceClient(), registerUser(), authenticate() — rather than reimplementing
 * queries, so what passes here is the code the application actually runs.
 *
 * All fixtures are namespaced with a run-specific marker and removed at the
 * end. It never drops the schema.
 */
import { Client, neonConfig } from '@neondatabase/serverless';
import { dataClient, serviceClient, runAsUser } from '../lib/db';
import { registerUser, authenticate } from '../lib/auth/users';
import { createSessionToken, verifySessionToken } from '../lib/auth/session';
import { RELATIONSHIPS } from '../lib/db/relationships';

if (typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${extra}`); }
}
function section(t: string) { console.log(`\n[${t}]`); }

const MARK = `phase3-${Date.now()}`;
const email = (who: string) => `${who}.${MARK}@phase3.test`;
const PW = 'integration-test-password-9f2b';

/**
 * Direct owner connection, used only for catalog inspection and fixture
 * teardown. The application itself never uses this — it connects as the
 * least-privilege role, which is the whole point of the RLS tests below.
 */
function admin() {
  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL_UNPOOLED!;
  return new Client({ connectionString: url });
}

async function main() {
  const sql = admin();
  await sql.connect();

  /* ============================================================ */
  section('schema — tables and types');

  const tables = (await sql.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows.map(r => r.table_name);
  check('28 tables exist (27 original + users)', tables.length === 28, `${tables.length}`);
  for (const t of ['users','profiles','candidate_profiles','jobs','applications',
                   'application_scores','application_analyses','resumes','ai_jobs']) {
    check(`table ${t}`, tables.includes(t));
  }

  const enums = (await sql.query(
    `select typname from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' and t.typtype='e' order by 1`)).rows.map(r => r.typname);
  check('11 enums exist', enums.length === 11, `${enums.length}: ${enums.join(',')}`);

  const exts = (await sql.query(
    `select extname from pg_extension where extname in ('pgcrypto','pg_trgm') order by 1`)).rows.map(r => r.extname);
  check('pgcrypto installed', exts.includes('pgcrypto'));
  check('pg_trgm installed', exts.includes('pg_trgm'));

  section('schema — constraints, indexes, triggers, functions');

  const counts = (await sql.query(`
    select
      (select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid
         join pg_namespace n on n.oid=r.relnamespace
        where n.nspname='public' and c.contype='f')::int as fks,
      (select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid
         join pg_namespace n on n.oid=r.relnamespace
        where n.nspname='public' and c.contype='c')::int as checks,
      (select count(*) from pg_indexes where schemaname='public')::int as idx,
      (select count(*) from pg_trigger t join pg_class r on r.oid=t.tgrelid
         join pg_namespace n on n.oid=r.relnamespace
        where n.nspname='public' and not t.tgisinternal)::int as trg
  `)).rows[0];
  check('foreign keys created', counts.fks >= 34, `${counts.fks}`);
  check('check constraints created', counts.checks >= 10, `${counts.checks}`);
  check('indexes created', counts.idx >= 24, `${counts.idx}`);
  check('updated_at triggers created', counts.trg >= 7, `${counts.trg}`);

  const fns = (await sql.query(
    `select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' order by 1`)).rows as { proname: string; prosecdef: boolean }[];
  const byName = Object.fromEntries(fns.map(f => [f.proname, f.prosecdef]));
  check('app_user_id() exists', 'app_user_id' in byName);
  check('app_user_id() is NOT security definer (reads a GUC only)', byName['app_user_id'] === false);
  for (const h of ['auth_role','is_admin','is_recruiter','my_candidate_id',
                   'owns_job','owns_application','candidate_visible_to_me']) {
    check(`helper ${h}() is SECURITY DEFINER`, byName[h] === true, String(byName[h]));
  }

  section('schema — RLS');

  const rls = (await sql.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by 1`)).rows as
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
  const noRls = rls.filter(r => !r.relrowsecurity).map(r => r.relname);
  const noForce = rls.filter(r => r.relrowsecurity && !r.relforcerowsecurity).map(r => r.relname);
  check('RLS enabled on every table', noRls.length === 0, `missing: ${noRls.join(',')}`);
  check('FORCE RLS on every RLS table', noForce.length === 0, `missing: ${noForce.join(',')}`);

  const pol = (await sql.query(
    `select count(*)::int as n from pg_policies where schemaname='public'`)).rows[0].n as number;
  check('policies created (60 static + 27 service + 15 loop-generated)', pol >= 100, `${pol}`);

  /* ============================================================ */
  section('authentication against real PostgreSQL');

  const recA = await registerUser({ email: email('reca'), password: PW, fullName: 'Rec A', role: 'recruiter' });
  const recB = await registerUser({ email: email('recb'), password: PW, fullName: 'Rec B', role: 'recruiter' });
  const canX = await registerUser({ email: email('canx'), password: PW, fullName: 'Cand X', role: 'candidate' });
  const canY = await registerUser({ email: email('cany'), password: PW, fullName: 'Cand Y', role: 'candidate' });
  check('registration returns ids', ['id' in recA, 'id' in recB, 'id' in canX, 'id' in canY].every(Boolean),
    JSON.stringify([recA, recB, canX, canY].map(r => 'error' in r ? r.error : 'ok')));
  if (!('id' in recA) || !('id' in recB) || !('id' in canX) || !('id' in canY)) {
    throw new Error('fixtures could not be created');
  }
  const A = recA.id, B = recB.id, X = canX.id, Y = canY.id;

  const dup = await registerUser({ email: email('reca'), password: PW, role: 'recruiter' });
  check('duplicate email is rejected by the unique constraint', 'error' in dup);

  const good = await authenticate(email('reca'), PW);
  check('correct password authenticates', good?.id === A);
  check('authenticated user carries its role', good?.role === 'recruiter', String(good?.role));
  check('no credential field leaks out of authenticate()',
    good !== null && !('password_hash' in (good as object)));

  const bad = await authenticate(email('reca'), 'wrong-password');
  check('wrong password is rejected', bad === null);
  const unknown = await authenticate(`nobody.${MARK}@phase3.test`, PW);
  check('unknown email is rejected identically', unknown === null);

  const hashRow = await sql.query('select password_hash from users where id=$1', [A]);
  const stored = hashRow.rows[0].password_hash as string;
  check('password is stored as a scrypt hash, never plaintext',
    stored.startsWith('scrypt$') && !stored.includes(PW));

  await sql.query('update profiles set is_active=false where id=$1', [B]);
  check('deactivated account cannot authenticate', (await authenticate(email('recb'), PW)) === null);
  await sql.query('update profiles set is_active=true where id=$1', [B]);
  check('reactivated account can authenticate again', (await authenticate(email('recb'), PW))?.id === B);

  const token = await createSessionToken(A);
  check('session token verifies and carries the subject', (await verifySessionToken(token))?.sub === A);
  check('a tampered token is rejected', (await verifySessionToken(token.slice(0, -2) + 'xx')) === null);
  check('an absent token is rejected', (await verifySessionToken(undefined)) === null);

  /* ============================================================ */
  section('fixtures');

  const svc = serviceClient();
  const cpX = (await svc.from('candidate_profiles').select('id').eq('user_id', X).single()).data;
  const cpY = (await svc.from('candidate_profiles').select('id').eq('user_id', Y).single()).data;
  check('registration created candidate_profiles rows', !!cpX?.id && !!cpY?.id);
  const CX = cpX.id as string, CY = cpY.id as string;

  await svc.from('candidate_profiles').update({ location: 'Dubai', years_experience: 4.5 }).eq('id', CX);
  await svc.from('candidate_profiles').update({ location: 'Berlin', years_experience: 7.0 }).eq('id', CY);

  const jobA = (await svc.from('jobs').insert({
    recruiter_id: A, title: 'Data Engineer', company: 'Acme', location: 'Remote',
    status: 'active', spec_version: 1,
  }).select('id').single()).data;
  const jobB = (await svc.from('jobs').insert({
    recruiter_id: B, title: 'Analyst', company: 'Globex', location: 'Berlin',
    status: 'active', spec_version: 1,
  }).select('id').single()).data;
  check('jobs created for both recruiters', !!jobA?.id && !!jobB?.id);
  const JA = jobA.id as string, JB = jobB.id as string;

  const resX = (await svc.from('resumes').insert({
    candidate_id: CX, storage_path: `${X}/r.pdf`, file_name: 'x.pdf', file_size: 1024, is_active: true,
  }).select('id').single()).data;
  const resY = (await svc.from('resumes').insert({
    candidate_id: CY, storage_path: `${Y}/r.pdf`, file_name: 'y.pdf', file_size: 2048, is_active: true,
  }).select('id').single()).data;
  check('resumes created', !!resX?.id && !!resY?.id);

  const appX = (await svc.from('applications').insert({
    job_id: JA, candidate_id: CX, resume_id: resX.id, job_spec_snapshot: {},
  }).select('id').single()).data;
  const appY = (await svc.from('applications').insert({
    job_id: JB, candidate_id: CY, resume_id: resY.id, job_spec_snapshot: {},
  }).select('id').single()).data;
  check('applications created', !!appX?.id && !!appY?.id);
  const PX = appX.id as string, PY = appY.id as string;

  await svc.from('application_scores').insert({
    application_id: PX, overall: 85.5, category: 'strong', engine_version: 'test-1',
  });
  // NOTE: strengths/concerns are jsonb. node-postgres binds a JS array as a
  // Postgres array literal, which jsonb rejects — so they are serialised.
  // PostgREST used to do this encoding for us.
  const anIns = await svc.from('application_analyses').insert({
    application_id: PX, model: 'test-model',
    concerns: JSON.stringify(['c1']), strengths: JSON.stringify(['s1']),
  });
  check('analysis fixture inserted', anIns.error === null, JSON.stringify(anIns.error));
  // PY deliberately has NO score and NO analysis, to exercise null embeds.
  const scoreCheck = await svc.from('application_scores').select('id').eq('application_id', PX).maybeSingle();
  check('score fixture inserted', scoreCheck.data !== null, JSON.stringify(scoreCheck.error));

  /* ============================================================ */
  section('jsonb binding (PostgREST used to encode this for us)');

  {
    const bad = await svc.from('application_analyses')
      .insert({ application_id: PY, model: 'm', concerns: ['x'] });
    check('a raw JS array into a jsonb column fails loudly, not silently',
      bad.error !== null && bad.error.code === '22P02', JSON.stringify(bad.error?.code));
    const good = await svc.from('application_analyses')
      .insert({ application_id: PY, model: 'm', concerns: JSON.stringify(['x']) });
    check('the serialised form is accepted', good.error === null, JSON.stringify(good.error));
    await svc.from('application_analyses').delete().eq('application_id', PY);
  }

  section('connection role — the BYPASSRLS trap');

  {
    const role = await runAsUser(null, async (c) => (await c.query(
      `select current_user as usr,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
              (select rolsuper from pg_roles where rolname = current_user) as super`)).rows[0]);
    check('the application does NOT connect as the table owner',
      role.usr !== 'neondb_owner', String(role.usr));
    check('the application role does NOT have BYPASSRLS',
      role.bypass === false, `bypassrls=${role.bypass}`);
    check('the application role is not a superuser', role.super === false);
    // Neon's neondb_owner carries BYPASSRLS, which overrides FORCE RLS. If the
    // app ever connects as it again, every policy silently stops applying.
  }

  section('RLS — real cross-tenant isolation');

  const asA = dataClient(A), asB = dataClient(B), asX = dataClient(X), anon = dataClient(null);

  const aSees = (await asA.from('applications').select('id')).data ?? [];
  const bSees = (await asB.from('applications').select('id')).data ?? [];
  check('recruiter A sees only their own application',
    aSees.length === 1 && aSees[0].id === PX, JSON.stringify(aSees.map((r: any) => r.id)));
  check('recruiter B sees only their own application',
    bSees.length === 1 && bSees[0].id === PY, JSON.stringify(bSees.map((r: any) => r.id)));

  const aProbesB = await asA.from('applications').select('id').eq('id', PY).maybeSingle();
  check("A cannot read B's application by id", aProbesB.data === null && aProbesB.error === null);
  const aProbesGhost = await asA.from('applications').select('id')
    .eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
  check('a hidden row is indistinguishable from a nonexistent one',
    JSON.stringify(aProbesB) === JSON.stringify(aProbesGhost));

  const xSees = (await asX.from('applications').select('id')).data ?? [];
  check('candidate X sees only their own application',
    xSees.length === 1 && xSees[0].id === PX, JSON.stringify(xSees));

  const anonApps = (await anon.from('applications').select('id')).data ?? [];
  check('anonymous sees no applications at all', anonApps.length === 0, `${anonApps.length}`);
  const anonJobs = (await anon.from('jobs').select('id, status')).data ?? [];
  check('anonymous sees active jobs only (public board)',
    anonJobs.length >= 2 && anonJobs.every((j: any) => j.status === 'active'), `${anonJobs.length}`);

  const idA = await runAsUser(A, async (c) => (await c.query('select app_user_id() as id')).rows[0].id);
  check('app_user_id() returns the identity the app set', idA === A);
  const idNone = await runAsUser(null, async (c) => (await c.query('select app_user_id() as id')).rows[0].id);
  check('app_user_id() is NULL with no identity', idNone === null);

  const leaked = await runAsUser(A, async (c) =>
    (await c.query(`select current_setting('app.user_id', true) as v`)).rows[0].v);
  check('identity is visible inside its own transaction', leaked === A);
  const afterTx = await runAsUser(null, async (c) =>
    (await c.query(`select current_setting('app.user_id', true) as v`)).rows[0].v);
  check('identity does NOT leak to the next transaction on a pooled connection',
    afterTx === null || afterTx === '', JSON.stringify(afterTx));

  const svcFlag = await runAsUser(A, async (c) =>
    (await c.query(`select current_setting('app.service_op', true) as v`)).rows[0].v);
  check('a normal request never has service_op set', svcFlag === null || svcFlag === '');

  const svcAll = (await svc.from('applications').select('id')).data ?? [];
  check('the service client sees everything (its intended role)', svcAll.length >= 2, `${svcAll.length}`);

  /* ============================================================ */
  section('embedded selects — executed against PostgreSQL');

  const e1 = await asA.from('applications')
    .select('id, stage, jobs(title, company), application_scores(category)').eq('id', PX).single();
  check('simple to-one embed returns an object',
    e1.data?.jobs?.title === 'Data Engineer' && !Array.isArray(e1.data.jobs), JSON.stringify(e1.data?.jobs));
  check('second embed on the same row resolves independently',
    e1.data?.application_scores?.category === 'strong', JSON.stringify(e1.data?.application_scores));

  const e2 = await asB.from('applications')
    .select('id, application_scores(overall), application_analyses(concerns)').eq('id', PY).single();
  check('a missing to-one embed is null, not [] and not {}',
    e2.data?.application_scores === null && e2.data?.application_analyses === null,
    JSON.stringify(e2.data));

  const e3 = await asA.from('applications')
    .select('id, candidate_profiles(location, years_experience, profiles(full_name, email))')
    .eq('id', PX).single();
  check('nested embed resolves two levels',
    e3.data?.candidate_profiles?.profiles?.full_name === 'Cand X', JSON.stringify(e3.data?.candidate_profiles));
  check('nested embed keeps the outer columns too',
    e3.data?.candidate_profiles?.location === 'Dubai');

  const e4 = await asA.from('applications').select('*, jobs(*), candidate_profiles(*)').eq('id', PX).single();
  check('table(*) returns the whole related row',
    e4.data?.jobs?.title === 'Data Engineer' && e4.data?.jobs?.company === 'Acme'
    && typeof e4.data?.jobs?.id === 'string', Object.keys(e4.data?.jobs ?? {}).length + ' keys');
  check('parent * still returns parent columns', e4.data?.stage === 'submitted');

  const e5 = await asA.from('applications')
    .select('id, job_id, candidate_id, jobs!inner(recruiter_id)').eq('id', PX).single();
  check('!inner returns the row when the related job is visible',
    e5.data?.jobs?.recruiter_id === A, JSON.stringify(e5.error));

  const e5b = await asB.from('applications')
    .select('id, job_id, candidate_id, jobs!inner(recruiter_id)').eq('id', PX).single();
  check("!inner excludes the row when the parent is not visible to this user",
    e5b.data === null && e5b.error?.code === 'PGRST116', JSON.stringify(e5b.error?.code));

  const e6 = await asA.from('applications')
    .select('id, stage, jobs(title), application_scores(overall, category)')
    .order('submitted_at', { ascending: false }).limit(5);
  check('embeds compose with order and limit', Array.isArray(e6.data) && e6.data.length === 1);

  const e7 = await asA.from('jobs')
    .select('id, title, profiles!jobs_recruiter_id_fkey(full_name, email)').eq('id', JA).single();
  check('foreign-key-hinted embed resolves', e7.data?.profiles?.full_name === 'Rec A',
    JSON.stringify(e7.data?.profiles));

  section('numeric and column types from real PostgreSQL');

  check('embedded numeric arrives as a JS number',
    typeof e1.data?.application_scores === 'object' &&
    typeof (await asA.from('applications').select('id, application_scores(overall)')
      .eq('id', PX).single()).data?.application_scores?.overall === 'number');
  const scoreRow = (await asA.from('applications').select('id, application_scores(overall)')
    .eq('id', PX).single()).data;
  check('embedded numeric keeps its value', scoreRow?.application_scores?.overall === 85.5,
    String(scoreRow?.application_scores?.overall));

  const directNum = (await svc.from('application_scores').select('overall').eq('application_id', PX).single()).data;
  check('directly-selected numeric is also a number (type parser)',
    typeof directNum?.overall === 'number', `${typeof directNum?.overall}`);
  check('direct and embedded numerics agree', directNum?.overall === scoreRow?.application_scores?.overall);

  const typed = (await asA.from('applications')
    .select('id, stage, submitted_at, jobs(title)').eq('id', PX).single()).data;
  check('uuid is a string', typeof typed?.id === 'string');
  check('enum is a string', typed?.stage === 'submitted');
  check('timestamptz is a Date', typed?.submitted_at instanceof Date, typeof typed?.submitted_at);
  const boolRow = (await svc.from('resumes').select('id, is_active').eq('id', resX.id).single()).data;
  check('boolean is a boolean', boolRow?.is_active === true);

  /* ============================================================ */
  section('core operations against real PostgreSQL');

  const ins = await svc.from('application_tags')
    .insert({ application_id: PX, tag: 'alpha' }).select('application_id, tag').single();
  check('insert + returning', ins.data?.tag === 'alpha', JSON.stringify(ins.error));

  const upd = await svc.from('jobs').update({ location: 'Hybrid' }).eq('id', JA).select('location').single();
  check('update + returning', upd.data?.location === 'Hybrid');

  const ups1 = await svc.from('application_scores').upsert(
    { application_id: PX, overall: 91.25, category: 'strong', engine_version: 'test-2' },
    { onConflict: 'application_id' });
  check('upsert on conflict updates rather than failing', ups1.error === null, JSON.stringify(ups1.error));
  const ups2 = (await svc.from('application_scores').select('overall, engine_version')
    .eq('application_id', PX).single()).data;
  check('upsert wrote the new values', ups2?.overall === 91.25 && ups2?.engine_version === 'test-2',
    JSON.stringify(ups2));

  const del = await svc.from('application_tags').delete().eq('application_id', PX).eq('tag', 'alpha');
  check('delete executes', del.error === null);
  const gone = (await svc.from('application_tags').select('tag').eq('application_id', PX)).data ?? [];
  check('delete removed the row', gone.length === 0);

  const inq = (await svc.from('jobs').select('id').in('id', [JA, JB])).data ?? [];
  check('in() matches both ids', inq.length === 2);
  const inEmpty = (await svc.from('jobs').select('id').in('id', [])).data ?? [];
  check('in([]) matches nothing', inEmpty.length === 0);

  const gteq = (await svc.from('application_scores').select('overall').gte('overall', 90)).data ?? [];
  check('gte() filters numerically', gteq.length === 1);
  const lteq = (await svc.from('application_scores').select('overall').lte('overall', 10)).data ?? [];
  check('lte() filters numerically', lteq.length === 0);

  const isNull = (await svc.from('applications').select('id').is('created_at', null)).data ?? [];
  check('is(null) executes', Array.isArray(isNull));

  const counted = await svc.from('jobs').select('id', { count: 'exact', head: true }).in('id', [JA, JB]);
  check('count + head returns a count and no rows', counted.count === 2 && counted.data === null,
    JSON.stringify({ c: counted.count, d: counted.data }));

  const ordered = (await svc.from('jobs').select('id, title').in('id', [JA, JB])
    .order('title', { ascending: true })).data ?? [];
  check('order() sorts ascending', ordered[0]?.title === 'Analyst', JSON.stringify(ordered.map((j: any) => j.title)));

  const lim = (await svc.from('jobs').select('id').in('id', [JA, JB]).limit(1)).data ?? [];
  check('limit() restricts rows', lim.length === 1);

  const ms = await svc.from('jobs').select('id').eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
  check('maybeSingle() on no rows returns null without error', ms.data === null && ms.error === null);
  const sg = await svc.from('jobs').select('id').eq('id', '00000000-0000-0000-0000-000000000000').single();
  check('single() on no rows returns PGRST116', sg.error?.code === 'PGRST116');

  /* ============================================================ */
  section('application flows');

  const recruiterBoard = (await asA.from('applications')
    .select('id, stage, screening_status, submitted_at, job_id, jobs(title), application_scores(overall, category)'))
    .data ?? [];
  check('recruiter dashboard query returns their pipeline',
    recruiterBoard.length === 1 && recruiterBoard[0].jobs?.title === 'Data Engineer');

  const candidateBoard = (await asX.from('applications')
    .select('id, stage, screening_status, submitted_at, jobs(title, company), application_scores(category)'))
    .data ?? [];
  check('candidate dashboard query returns their applications',
    candidateBoard.length === 1 && candidateBoard[0].jobs?.company === 'Acme');

  const detail = (await asA.from('applications').select(
    'id, stage, screening_status, submitted_at, job_id, resume_id, jobs(id, title, company), ' +
    'candidate_profiles(location, years_experience, headline, summary, phone, linkedin_url, portfolio_url, profiles(full_name, email)), ' +
    'application_scores(overall, category, components, weights, engine_version), ' +
    'application_analyses(requirement_matrix, skill_intelligence, experience_intel, strengths, concerns, summary, model)'
  ).eq('id', PX).single()).data;
  check('the full recruiter assessment query executes', !!detail && detail.id === PX);
  check('assessment carries nested candidate identity',
    detail?.candidate_profiles?.profiles?.email === email('canx'));
  check('assessment carries the analysis', detail?.application_analyses?.model === 'test-model');

  const exportRows = (await asA.from('applications').select(
    'id, stage, screening_status, submitted_at, ' +
    'candidate_profiles(location, years_experience, profiles(full_name, email)), ' +
    'application_scores(overall, category, components), ' +
    'application_analyses(requirement_matrix, skill_intelligence, strengths, concerns)'
  ).eq('job_id', JA)).data ?? [];
  check('the export query executes and returns rows', exportRows.length === 1);
  check('export numeric is a number', typeof exportRows[0]?.candidate_profiles?.years_experience === 'number',
    typeof exportRows[0]?.candidate_profiles?.years_experience);

  const compare = (await asA.from('applications')
    .select('id, candidate_profiles(profiles(full_name)), application_analyses(requirement_matrix, strengths, concerns)')
    .in('id', [PX])).data ?? [];
  check('the compare query executes', compare.length === 1 &&
    compare[0].candidate_profiles?.profiles?.full_name === 'Cand X');

  const aiQuery = (await svc.from('applications')
    .select('*, jobs(*), candidate_profiles(*)').eq('id', PX).single()).data;
  check('the AI service query executes with whole-row embeds',
    aiQuery?.jobs?.title === 'Data Engineer' && typeof aiQuery?.candidate_profiles?.years_experience === 'number');

  section('relationship registry matches the real catalog');

  for (const [parent, rels] of Object.entries(RELATIONSHIPS)) {
    for (const [name, r] of Object.entries(rels)) {
      const q = await sql.query(
        `select 1 from information_schema.columns
          where table_schema='public' and table_name=$1 and column_name=$2`,
        [parent === r.table ? parent : (r.localColumn === 'id' ? r.table : parent),
         r.localColumn === 'id' ? r.foreignColumn : r.localColumn]);
      check(`${parent}.${name} columns exist in the live schema`, q.rowCount === 1);
    }
  }

  /* ============================================================ */
  section('cleanup');

  // jobs.recruiter_id is ON DELETE RESTRICT, so jobs must go before the users
  // that own them. Deleting jobs cascades applications -> scores/analyses.
  await sql.query(
    `delete from jobs where recruiter_id in (select id from profiles where email like $1)`,
    [`%${MARK}@phase3.test`]);
  const cleanup = await sql.query(
    `delete from users where email like $1 returning id`, [`%${MARK}@phase3.test`]);
  check('test users removed (cascades to profiles, candidates, resumes)',
    cleanup.rowCount === 4, `${cleanup.rowCount}`);
  const orphanJobs = await sql.query('select count(*)::int n from jobs where id = any($1)', [[JA, JB]]);
  check('fixture jobs removed by cascade', orphanJobs.rows[0].n === 0, `${orphanJobs.rows[0].n}`);
  const leftovers = await sql.query(
    `select count(*)::int n from profiles where email like $1`, [`%${MARK}@phase3.test`]);
  check('no fixture profiles remain', leftovers.rows[0].n === 0);
  const schemaIntact = await sql.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE'`);
  check('schema is left intact after cleanup', schemaIntact.rows[0].n === 28, `${schemaIntact.rows[0].n}`);

  await sql.end();

  console.log('');
  console.log('====================================================');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n  - ' + failures.join('\n  - '));
  console.log('====================================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
