/**
 * Embedded-resource suite.
 *
 * Covers the PostgREST-style nested selects the application uses, which the
 * Phase 1 compatibility layer refused at runtime.
 *
 * Like the other migration tests these run without a database: the builder is
 * driven by a fake runner that captures the SQL and returns whatever rows the
 * test supplies. The properties under test are the statements produced and the
 * shapes returned — both of which must hold before a database is involved.
 *
 * The final section is the regression guard that matters most: it extracts
 * every select spec written in the application and asserts each one builds.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QueryBuilder } from '../lib/db/builder';
import { parseSelect } from '../lib/db/embed';
import { RELATIONSHIPS } from '../lib/db/relationships';
// Loading the pool registers the NUMERIC type parser as a side effect,
// exactly as it does in the application. Imported for that reason.
import '../lib/db/pool';
import { types as pgTypes } from '@neondatabase/serverless';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function section(title: string) { console.log(`\n[${title}]`); }

const root = join(import.meta.dirname, '..');

interface Captured { text: string; values: unknown[] }

function fake(rows: Record<string, unknown>[] = [], sink?: Captured[]) {
  return (<R,>(fn: (client: any) => Promise<R>): Promise<R> =>
    fn({
      query: async (text: string, values: unknown[] = []) => {
        sink?.push({ text, values });
        return { rows, rowCount: rows.length };
      },
    })) as never;
}

const qb = (table: string, rows: Record<string, unknown>[] = [], sink?: Captured[]) =>
  new QueryBuilder(fake(rows, sink), table);

/** Collects every .select('…') spec written in the application. */
function appSelectSpecs(): { file: string; table: string; spec: string }[] {
  const out: { file: string; table: string; spec: string }[] = [];
  const pattern = /\.from\(\s*'([a-z_]+)'\s*\)[\s\S]{0,400}?\.select\(\s*(['"`])([\s\S]*?)\2/g;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(pattern)) {
        if (m[3].includes('(')) {
          out.push({
            file: full.slice(root.length + 1),
            table: m[1],
            spec: m[3].replace(/\s+/g, ' ').trim(),
          });
        }
      }
    }
  };
  walk(join(root, 'app'));
  walk(join(root, 'lib'));
  return out;
}

async function main() {
  /* ================================================================ */
  section('parsing');

  {
    const p = parseSelect('id, stage, jobs(title, company), application_scores(category)');
    check('plain columns are separated from embeds',
      JSON.stringify(p.columns) === '["id","stage"]' && p.embeds.length === 2,
      JSON.stringify(p));
    check('embed columns are captured',
      JSON.stringify(p.embeds[0].columns) === '["title","company"]');

    const nested = parseSelect('id, candidate_profiles(location, profiles(full_name))');
    check('nested embeds parse two levels deep',
      nested.embeds[0].embeds[0]?.name === 'profiles',
      JSON.stringify(nested.embeds[0]));

    const inner = parseSelect('id, jobs!inner(recruiter_id)');
    check('!inner is recognised', inner.embeds[0].inner === true);

    const hinted = parseSelect('id, profiles!jobs_recruiter_id_fkey(full_name)');
    check('a foreign-key hint resolves to the relationship name',
      hinted.embeds[0].name === 'profiles' && hinted.embeds[0].inner === false);

    const star = parseSelect('*, jobs(*)');
    check("'*' survives on both sides",
      star.columns[0] === '*' && star.embeds[0].columns[0] === '*');

    let unbalanced = false;
    try { parseSelect('id, jobs(title'); } catch { unbalanced = true; }
    check('unbalanced parentheses are rejected', unbalanced);
  }

  /* ================================================================ */
  section('SQL generation');

  {
    let sink: Captured[] = [];
    await qb('applications', [], sink).select('id, jobs(title, company)');
    const sql = sink[0].text;
    check('embed becomes a correlated subquery, not a join',
      sql.includes('(select jsonb_build_object(') && !/\bjoin\b/i.test(sql), sql);
    check('subquery correlates on the declared foreign key',
      sql.includes('"e1"."id" = "applications"."job_id"'), sql);
    check('embed is aliased to the relationship name',
      sql.includes('as "jobs"'), sql);

    sink = [];
    await qb('applications', [], sink).select('id, application_scores(category)');
    check('reverse to-one correlates on the child column',
      sink[0].text.includes('"e1"."application_id" = "applications"."id"'), sink[0].text);

    sink = [];
    await qb('applications', [], sink).select('id, candidate_profiles(profiles(full_name))');
    check('nested embed correlates against its own parent alias',
      sink[0].text.includes('"e2"."id" = "e1"."user_id"'), sink[0].text);

    sink = [];
    await qb('applications', [], sink).select('*, jobs(*)');
    check("'*' inside an embed becomes to_jsonb(row)",
      sink[0].text.includes('to_jsonb("e1".*)'), sink[0].text);

    sink = [];
    await qb('applications', [], sink).select('id, jobs!inner(recruiter_id)').eq('id', 'x');
    check('!inner adds an EXISTS guard to the outer WHERE',
      /exists \(select 1 from "jobs"/.test(sink[0].text), sink[0].text);
    check('!inner keeps the original filter too',
      sink[0].text.includes('"id" = $1'), sink[0].text);

    sink = [];
    await qb('applications', [], sink).select('id, jobs(title)')
      .eq('candidate_id', 'c').order('submitted_at', { ascending: false }).limit(5);
    check('embeds compose with filters, ordering and limit',
      /where "candidate_id" = \$1 order by "submitted_at" desc limit \$2/.test(sink[0].text),
      sink[0].text);
  }

  /* ================================================================ */
  section('result shape');

  {
    // pg decodes jsonb into plain objects, so the row arrives already shaped.
    const row = { id: 'a', stage: 'submitted', jobs: { title: 'Data Engineer', company: 'Acme' } };
    const one = await qb('applications', [row]).select('id, stage, jobs(title, company)')
      .eq('id', 'a').single();
    const data = one.data as any;
    check('a to-one embed is an object, not an array',
      data?.jobs && !Array.isArray(data.jobs), JSON.stringify(data?.jobs));
    check('embedded fields are reachable as the callers expect',
      data.jobs.title === 'Data Engineer' && data.jobs.company === 'Acme');

    const missing = await qb('applications', [{ id: 'b', jobs: null }])
      .select('id, jobs(title)').eq('id', 'b').single();
    check('a missing related row is null, not an empty object',
      (missing.data as any).jobs === null, JSON.stringify(missing.data));

    const nested = await qb('applications', [{
      id: 'c', candidate_profiles: { location: 'Dubai', profiles: { full_name: 'A. Candidate' } },
    }]).select('id, candidate_profiles(location, profiles(full_name))').single();
    check('nested embeds nest in the result too',
      (nested.data as any).candidate_profiles.profiles.full_name === 'A. Candidate');

    const nestedNull = await qb('applications', [{
      id: 'd', candidate_profiles: { location: 'Dubai', profiles: null },
    }]).select('id, candidate_profiles(location, profiles(full_name))').single();
    check('a null inner embed does not break the outer one',
      (nestedNull.data as any).candidate_profiles.profiles === null);

    const list = await qb('applications', [
      { id: '1', jobs: { title: 'A' } },
      { id: '2', jobs: null },
    ]).select('id, jobs(title)');
    check('lists keep per-row embed shapes independent',
      Array.isArray(list.data) && (list.data as any)[0].jobs.title === 'A'
      && (list.data as any)[1].jobs === null);

    const none = await qb('applications', []).select('id, jobs(title)');
    check('no parent rows yields an empty array, no error',
      Array.isArray(none.data) && (none.data as any).length === 0 && none.error === null);
  }

  /* ================================================================ */
  section('refusals are preserved');

  {
    const undeclared = await qb('applications').select('id, resumes(file_name)');
    check('an undeclared relationship is refused, not guessed',
      undeclared.error !== null && /No declared relationship/.test(undeclared.error.message),
      JSON.stringify(undeclared.error));

    const wrongParent = await qb('jobs').select('id, application_scores(overall)');
    check('a relationship valid elsewhere is refused on the wrong parent',
      wrongParent.error !== null, JSON.stringify(wrongParent.error));

    const injected = await qb('applications').select('id, jobs(title); drop table jobs)');
    check('SQL inside an embed is refused', injected.error !== null);

    const mixed = await qb('applications').select('id, jobs(*, title)');
    check("'*' mixed with named columns inside an embed is refused",
      mixed.error !== null, JSON.stringify(mixed.error));

    const inReturning = await qb('applications')
      .insert({ id: 'x' }).select('id, jobs(title)');
    check('embeds are refused in a RETURNING clause',
      inReturning.error !== null && /RETURNING/.test(inReturning.error.message),
      JSON.stringify(inReturning.error));
  }

  /* ================================================================ */
  section('authorization is preserved');

  {
    const embed = readFileSync(join(root, 'lib/db/embed.ts'), 'utf8');
    const rels = readFileSync(join(root, 'lib/db/relationships.ts'), 'utf8');

    check('embedding introduces no service-role escape',
      !/service_op|runAsService|serviceClient/.test(embed));
    check('embedding sets no session state of its own',
      !/set_config|SET LOCAL/i.test(embed));
    check('embedded tables are read through subqueries, so their RLS still applies',
      /select .* from \$\{target\}|from \$\{target\}/.test(embed) || embed.includes('from ${target}'));
    check('identifiers inside embeds are validated before reaching SQL',
      /IDENT_RE\.test/.test(embed));
    check('object keys are validated, not interpolated blindly',
      /function literal\(/.test(embed) && /Unsafe object key/.test(embed));
    check('every declared relationship is to-one',
      Object.values(RELATIONSHIPS).every((byName) =>
        Object.values(byName).every((r) => r.cardinality === 'one')));
    check('the relationship map is explicit, not derived at runtime',
      !/information_schema|pg_catalog|pg_constraint/.test(rels));
  }

  /* ================================================================ */
  section('type fidelity');

  {
    // Found during the Phase 2 review: an embedded numeric arrives as a JSON
    // number (jsonb_build_object), while the same column selected directly
    // arrives as a string, because node-postgres decodes NUMERIC that way.
    // Callers are written against numbers, so the transport normalises it.
    const pool = readFileSync(join(root, 'lib/db/pool.ts'), 'utf8');
    check('numeric is decoded as a number, matching the embedded path',
      /setTypeParser\(1700/.test(pool), 'no NUMERIC type parser registered');
    check('the reason is documented, not a bare magic number',
      /numeric\(5,2\)|OID 1700/.test(pool));

    // The parser is registered as a side effect of loading the pool module,
    // which every query path imports. Load it the same way the app does.
    const parsed = pgTypes.getTypeParser(1700, 'text')('85.50');
    check('loading the pool registers the NUMERIC parser',
      typeof parsed === 'number', `${JSON.stringify(parsed)} (${typeof parsed})`);
    check('the parsed value is exact for this schema', parsed === 85.5, String(parsed));
  }

  /* ================================================================ */
  section('every application query builds');

  {
    const specs = appSelectSpecs();
    check('the scan found the expected embedded selects',
      specs.length >= 18, `found ${specs.length}`);

    let built = 0;
    const failures: string[] = [];
    for (const { file, table, spec } of specs) {
      // The table comes from the same .from(...) the regex matched, so there
      // is no guessing about which parent a spec belongs to.
      const res = await qb(table).select(spec);
      if (res.error && res.error.code === 'TIP_BUILD') {
        failures.push(`${file}: ${res.error.message}`);
      } else {
        built += 1;
      }
    }
    check(`all ${specs.length} embedded selects build without error`,
      failures.length === 0, failures.join(' | '));
    check('none fall back to the old refusal path', built === specs.length);
  }

  console.log('');
  console.log('====================================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log('====================================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
