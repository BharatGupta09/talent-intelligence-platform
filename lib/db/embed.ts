import 'server-only';
import { relationship } from './relationships';

/**
 * Embedded-resource parsing and SQL generation.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * PostgREST let a select string pull related rows inline:
 *
 *   .select('id, stage, jobs(title), candidate_profiles(profiles(full_name))')
 *
 * 18 call sites in this application use that, some two levels deep, so the
 * queries are reproduced rather than the call sites rewritten.
 *
 * Each embed becomes a correlated scalar subquery returning jsonb. That choice
 * matters for two reasons:
 *
 *   1. RLS still applies. A subquery over `jobs` is filtered by the `jobs`
 *      policies exactly as a top-level read would be, which is what PostgREST
 *      did. A recruiter who cannot see a job gets null for the embed rather
 *      than someone else's row.
 *   2. A missing related row yields SQL NULL, which is the shape the calling
 *      code already handles (`a.jobs as ... | null`).
 *
 * A LEFT JOIN would have been wrong for (2) without extra work, and would have
 * multiplied parent rows if any relationship were ever to-many.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  const trimmed = name.trim();
  if (!IDENT_RE.test(trimmed)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${trimmed}"`;
}

/** A single-quoted SQL string literal, for jsonb_build_object keys. */
function literal(text: string): string {
  if (!IDENT_RE.test(text)) {
    throw new Error(`Unsafe object key: ${JSON.stringify(text)}`);
  }
  return `'${text}'`;
}

export interface EmbedNode {
  /** Relationship name as written, e.g. `jobs`. */
  name: string;
  /** `!inner` — the parent row disappears when the embed has no match. */
  inner: boolean;
  /** Plain columns requested on the embedded table, or '*'. */
  columns: string[];
  /** Further embeds nested inside this one. */
  embeds: EmbedNode[];
}

export interface ParsedSelect {
  columns: string[];
  embeds: EmbedNode[];
}

/**
 * Splits a select spec on commas that sit at depth zero, so that
 * `a, b(c, d), e` yields ['a', 'b(c, d)', 'e'].
 */
function splitTopLevel(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) throw new Error('Unbalanced parentheses in select.');
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (depth !== 0) throw new Error('Unbalanced parentheses in select.');
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Parses a PostgREST select string into plain columns and embeds. */
export function parseSelect(spec: string): ParsedSelect {
  const columns: string[] = [];
  const embeds: EmbedNode[] = [];

  for (const part of splitTopLevel(spec)) {
    const open = part.indexOf('(');
    if (open === -1) {
      if (part.includes(':')) {
        throw new Error(`Column aliasing is not supported: ${JSON.stringify(part)}`);
      }
      columns.push(part);
      continue;
    }

    if (!part.endsWith(')')) {
      throw new Error(`Malformed embedded select: ${JSON.stringify(part)}`);
    }

    // `profiles!jobs_recruiter_id_fkey` or `jobs!inner`
    let head = part.slice(0, open).trim();
    let inner = false;
    const bang = head.indexOf('!');
    if (bang !== -1) {
      const hint = head.slice(bang + 1).trim();
      head = head.slice(0, bang).trim();
      if (hint === 'inner') {
        inner = true;
      }
      // Any other hint is a foreign-key disambiguator. The relationship map is
      // explicit, so there is nothing to disambiguate — but the hint is
      // validated rather than ignored silently.
      else if (!IDENT_RE.test(hint)) {
        throw new Error(`Unrecognised embed hint: ${JSON.stringify(hint)}`);
      }
    }

    const body = part.slice(open + 1, -1);
    const child = parseSelect(body);
    embeds.push({ name: head, inner, columns: child.columns, embeds: child.embeds });
  }

  return { columns, embeds };
}

/** Allocates the aliases used by correlated subqueries: e0, e1, e2 … */
class Aliases {
  private n = 0;
  next(): string {
    this.n += 1;
    return `e${this.n}`;
  }
}

/**
 * Builds the jsonb expression for one embed, correlated against `parentAlias`.
 * Returns null when the relationship is not declared.
 */
function embedExpression(
  parentTable: string,
  parentAlias: string,
  node: EmbedNode,
  aliases: Aliases,
): string {
  const rel = relationship(parentTable, node.name);
  if (!rel) {
    throw new Error(
      `No declared relationship ${parentTable} -> ${node.name}. ` +
      `Add it to lib/db/relationships.ts if the schema really has one.`,
    );
  }

  const alias = aliases.next();
  const target = ident(rel.table);
  const a = ident(alias);

  // Object payload: either the whole row, or the named columns plus any
  // nested embeds.
  let payload: string;
  const starOnly =
    node.columns.length === 1 && node.columns[0] === '*' && node.embeds.length === 0;
  if (starOnly) {
    payload = `to_jsonb(${a}.*)`;
  } else if (node.columns.includes('*')) {
    // Reached when '*' is mixed with named columns or nested embeds. PostgREST
    // would merge them; doing that here would mean guessing, so it is refused.
    throw new Error(
      `'*' cannot be combined with named columns or nested embeds inside ` +
      `${node.name}(...).`,
    );
  } else {
    const pairs: string[] = [];
    for (const col of node.columns) {
      pairs.push(`${literal(col)}, ${a}.${ident(col)}`);
    }
    for (const child of node.embeds) {
      pairs.push(
        `${literal(child.name)}, ${embedExpression(rel.table, alias, child, aliases)}`,
      );
    }
    if (pairs.length === 0) {
      throw new Error(`Embedded select ${node.name}() requested no columns.`);
    }
    payload = `jsonb_build_object(${pairs.join(', ')})`;
  }

  // `limit 1` is defensive. Every relationship here is to-one by foreign key
  // or UNIQUE constraint, so it cannot change the result — but without it a
  // scalar subquery would raise if the schema ever drifted, and a hard error
  // in a list page is worse than a deterministic row.
  return (
    `(select ${payload} from ${target} ${a} ` +
    `where ${a}.${ident(rel.foreignColumn)} = ${ident(parentAlias)}.${ident(rel.localColumn)} ` +
    `limit 1)`
  );
}

export interface EmbedSql {
  /** Expressions to append to the outer SELECT list. */
  selectExpressions: string[];
  /** Conditions to AND into the outer WHERE, for `!inner` embeds. */
  whereConditions: string[];
}

/**
 * Turns the parsed embeds into SQL fragments for the outer query.
 * `parentTable` doubles as the outer alias, since the builder emits
 * `select ... from "table"` with no alias of its own.
 */
export function buildEmbeds(parentTable: string, embeds: EmbedNode[]): EmbedSql {
  const aliases = new Aliases();
  const selectExpressions: string[] = [];
  const whereConditions: string[] = [];

  for (const node of embeds) {
    const expr = embedExpression(parentTable, parentTable, node, aliases);
    selectExpressions.push(`${expr} as ${ident(node.name)}`);

    if (node.inner) {
      const rel = relationship(parentTable, node.name)!;
      const alias = aliases.next();
      const a = ident(alias);
      whereConditions.push(
        `exists (select 1 from ${ident(rel.table)} ${a} ` +
        `where ${a}.${ident(rel.foreignColumn)} = ${ident(parentTable)}.${ident(rel.localColumn)})`,
      );
    }
  }

  return { selectExpressions, whereConditions };
}
