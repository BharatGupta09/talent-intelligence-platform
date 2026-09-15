import 'server-only';
import type { PoolClient } from '@neondatabase/serverless';

/**
 * A deliberately small PostgREST-compatible query builder.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * The application had 154 `.from(...)` call sites written against the
 * supabase-js builder. Rewriting each one into SQL would have been a very
 * large, error-prone diff through security-sensitive code. Instead this
 * reproduces the exact subset of the builder the application actually uses,
 * so the call sites keep their shape and the reviewable surface is this file.
 *
 * It implements only what is used, and refuses anything else loudly. That is
 * the safety property: an unsupported construct raises instead of silently
 * returning the wrong rows. Grammar in use, measured from the codebase:
 *
 *   select · insert · update · upsert(onConflict) · delete
 *   eq · in · gte · lte · is
 *   order(column, { ascending }) · limit(n)
 *   single() · maybeSingle()
 *   select(cols, { count: 'exact', head: true })
 *
 * Notably NOT implemented, because nothing uses them: or(), neq(), gt(), lt(),
 * like/ilike, contains, ranges, column aliasing, and embedded resources. The
 * ten embedded selects are hand-written SQL in lib/db/queries.ts.
 */

/* ------------------------------------------------------------------ */
/* Result shapes — identical to supabase-js, including never throwing.  */

export interface PgError {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
}

export interface Result<T> {
  data: T;
  error: PgError | null;
  count: number | null;
  status: number;
}

function err(message: string, code: string, details: string | null = null): PgError {
  return { message, details, hint: null, code };
}

/* ------------------------------------------------------------------ */
/* Identifier safety                                                    */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Table and column names are never parameterisable in SQL, so they are
 * validated against a strict pattern and quoted. Anything else throws before
 * a statement is built.
 */
function ident(name: string): string {
  const trimmed = name.trim();
  if (!IDENT_RE.test(trimmed)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${trimmed}"`;
}

/**
 * The credential store is never reachable through this builder. lib/auth owns
 * it and goes through runAuthOp(). Blocking it here means an accidental
 * `.from('users')` fails immediately rather than depending on RLS alone.
 */
const FORBIDDEN_TABLES = new Set(['users']);

function columnList(select: string): string {
  const spec = select.trim();
  if (spec === '*') return '*';
  if (spec.includes('(')) {
    throw new Error(
      `Embedded selects are not supported by the compatibility layer: ` +
      `${JSON.stringify(select)}. Use the hand-written query in lib/db/queries.ts.`,
    );
  }
  if (spec.includes(':')) {
    throw new Error(`Column aliasing is not supported: ${JSON.stringify(select)}`);
  }
  return spec.split(',').map((c) => ident(c)).join(', ');
}

/* ------------------------------------------------------------------ */

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type Filter =
  | { kind: 'eq' | 'gte' | 'lte'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'is'; column: string; value: null };

interface OrderBy { column: string; ascending: boolean }

export type Runner = <R>(
  fn: (client: PoolClient) => Promise<R>,
) => Promise<R>;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class QueryBuilder<Row = any, Out = Row[] | null>
  implements PromiseLike<Result<Out>> {
  private op: Op = 'select';
  private selection = '*';
  private wantsReturning = false;
  private countExact = false;
  private headOnly = false;
  private filters: Filter[] = [];
  private orderBy: OrderBy[] = [];
  private limitN: number | null = null;
  private payload: Record<string, unknown>[] = [];
  private updates: Record<string, unknown> = {};
  private conflictTarget: string | null = null;
  private rowMode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly run: Runner, private readonly table: string) {
    if (FORBIDDEN_TABLES.has(table)) {
      throw new Error(
        `Table "${table}" is not reachable through the data client. ` +
        `Credentials are owned by lib/auth.`,
      );
    }
    ident(table);
  }

  /* -------------------------------------------------- operations */

  select<R = Row>(
    columns = '*',
    opts?: { count?: 'exact'; head?: boolean },
  ): QueryBuilder<R, R[] | null> {
    if (this.op === 'select') {
      this.selection = columns;
    } else {
      // `.insert(...).select('id')` — RETURNING rather than a new statement.
      this.wantsReturning = true;
      this.selection = columns;
    }
    if (opts?.count === 'exact') this.countExact = true;
    if (opts?.head) this.headOnly = true;
    return this as unknown as QueryBuilder<R, R[] | null>;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = 'insert';
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.op = 'update';
    this.updates = values;
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string },
  ): this {
    this.op = 'upsert';
    this.payload = Array.isArray(values) ? values : [values];
    if (!opts?.onConflict) {
      throw new Error('upsert() requires an explicit onConflict target.');
    }
    this.conflictTarget = opts.onConflict;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  /* -------------------------------------------------- filters */

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ kind: 'gte', column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ kind: 'lte', column, value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: 'in', column, values: values ?? [] });
    return this;
  }

  is(column: string, value: null): this {
    if (value !== null) {
      throw new Error('is() is only implemented for null.');
    }
    this.filters.push({ kind: 'is', column, value: null });
    return this;
  }

  /* -------------------------------------------------- modifiers */

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: opts?.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  single<R = Row>(): QueryBuilder<R, R | null> {
    this.rowMode = 'single';
    return this as unknown as QueryBuilder<R, R | null>;
  }

  maybeSingle<R = Row>(): QueryBuilder<R, R | null> {
    this.rowMode = 'maybeSingle';
    return this as unknown as QueryBuilder<R, R | null>;
  }

  /* -------------------------------------------------- SQL */

  private where(values: unknown[]): string {
    if (this.filters.length === 0) return '';
    const parts = this.filters.map((f) => {
      const col = ident(f.column);
      if (f.kind === 'is') return `${col} is null`;
      if (f.kind === 'in') {
        if (f.values.length === 0) return 'false';
        const slots = f.values.map((v) => `$${values.push(v)}`);
        return `${col} in (${slots.join(', ')})`;
      }
      const opSql = f.kind === 'eq' ? '=' : f.kind === 'gte' ? '>=' : '<=';
      return `${col} ${opSql} $${values.push(f.value)}`;
    });
    return ` where ${parts.join(' and ')}`;
  }

  private tail(values: unknown[]): string {
    let sql = '';
    if (this.orderBy.length > 0) {
      const parts = this.orderBy.map(
        (o) => `${ident(o.column)} ${o.ascending ? 'asc' : 'desc'}`,
      );
      sql += ` order by ${parts.join(', ')}`;
    }
    if (this.limitN !== null) sql += ` limit $${values.push(this.limitN)}`;
    return sql;
  }

  private build(): { text: string; values: unknown[] } {
    const t = ident(this.table);
    const values: unknown[] = [];

    if (this.op === 'select') {
      const cols = this.headOnly ? '1' : columnList(this.selection);
      const text = `select ${cols} from ${t}${this.where(values)}${this.tail(values)}`;
      return { text, values };
    }

    if (this.op === 'delete') {
      const returning = this.wantsReturning
        ? ` returning ${columnList(this.selection)}`
        : '';
      return { text: `delete from ${t}${this.where(values)}${returning}`, values };
    }

    if (this.op === 'update') {
      const keys = Object.keys(this.updates);
      if (keys.length === 0) throw new Error('update() called with no columns.');
      const sets = keys.map((k) => `${ident(k)} = $${values.push(this.updates[k])}`);
      const returning = this.wantsReturning
        ? ` returning ${columnList(this.selection)}`
        : '';
      return {
        text: `update ${t} set ${sets.join(', ')}${this.where(values)}${returning}`,
        values,
      };
    }

    // insert / upsert
    if (this.payload.length === 0) throw new Error('insert() called with no rows.');
    const keys = Object.keys(this.payload[0]);
    if (keys.length === 0) throw new Error('insert() called with an empty row.');
    for (const row of this.payload) {
      const rowKeys = Object.keys(row);
      if (rowKeys.length !== keys.length || rowKeys.some((k) => !keys.includes(k))) {
        throw new Error('insert() rows must all have the same columns.');
      }
    }
    const cols = keys.map((k) => ident(k)).join(', ');
    const tuples = this.payload
      .map((row) => `(${keys.map((k) => `$${values.push(row[k])}`).join(', ')})`)
      .join(', ');

    let text = `insert into ${t} (${cols}) values ${tuples}`;
    if (this.op === 'upsert') {
      const target = this.conflictTarget!
        .split(',')
        .map((c) => ident(c))
        .join(', ');
      const assignments = keys
        .filter((k) => !this.conflictTarget!.split(',').map((c) => c.trim()).includes(k))
        .map((k) => `${ident(k)} = excluded.${ident(k)}`);
      text += assignments.length
        ? ` on conflict (${target}) do update set ${assignments.join(', ')}`
        : ` on conflict (${target}) do nothing`;
    }
    if (this.wantsReturning) text += ` returning ${columnList(this.selection)}`;
    return { text, values };
  }

  /* -------------------------------------------------- execution */

  private shape(rows: Record<string, unknown>[], rowCount: number): Result<any> {
    // head:true — the caller wants only the count.
    if (this.headOnly) {
      return {
        data: null as any,
        error: null,
        count: this.countExact ? rowCount : null,
        status: 200,
      };
    }

    if (this.rowMode === 'single' || this.rowMode === 'maybeSingle') {
      if (rows.length > 1) {
        // Both modes treat "more than one" as a programming error, exactly as
        // PostgREST does. Returning the first row here would silently hand back
        // an arbitrary record.
        return {
          data: null as any,
          error: err(
            'JSON object requested, multiple (or no) rows returned',
            'PGRST116',
            `Results contain ${rows.length} rows`,
          ),
          count: null,
          status: 406,
        };
      }
      if (rows.length === 0) {
        if (this.rowMode === 'maybeSingle') {
          return { data: null as any, error: null, count: null, status: 200 };
        }
        // single() on zero rows is an error — and critically, this is the same
        // answer whether the row does not exist or RLS filtered it away. That
        // indistinguishability is what stops an attacker probing for valid ids.
        return {
          data: null as any,
          error: err(
            'JSON object requested, multiple (or no) rows returned',
            'PGRST116',
            'Results contain 0 rows',
          ),
          count: null,
          status: 406,
        };
      }
      return { data: rows[0] as any, error: null, count: null, status: 200 };
    }

    return {
      data: rows as any,
      error: null,
      count: this.countExact ? rowCount : null,
      status: 200,
    };
  }

  private async execute(): Promise<Result<Out>> {
    let statement: { text: string; values: unknown[] };
    try {
      statement = this.build();
    } catch (e) {
      // A malformed query is a bug, not a database error. Surface it as an
      // error result so call sites behave the way they already do.
      return {
        data: null as any,
        error: err((e as Error).message, 'TIP_BUILD'),
        count: null,
        status: 400,
      };
    }

    try {
      const res = await this.run((client) =>
        client.query(statement.text, statement.values as never[]),
      );
      const rows = (res.rows ?? []) as Record<string, unknown>[];
      const rowCount = typeof res.rowCount === 'number' ? res.rowCount : rows.length;
      return this.shape(rows, rowCount) as Result<Out>;
    } catch (e) {
      const pg = e as { message?: string; code?: string; detail?: string };
      return {
        data: null as any,
        error: err(pg.message ?? 'Database error', pg.code ?? 'TIP_DB', pg.detail ?? null),
        count: null,
        status: 500,
      };
    }
  }

  then<R1 = Result<Out>, R2 = never>(
    onfulfilled?: ((value: Result<Out>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}
