// Mike's database client: the slice of the supabase-js query builder the
// backend uses, executed directly on Postgres over `pg`.
//
// It replaces PostgREST without rewriting every call site: `db.from(table)`
// chains and `db.rpc(fn, args)` keep their shape and their results. Queries
// are built the way PostgREST builds them: rows come back through `json_agg`
// (so timestamps are ISO strings, bigints numbers and jsonb objects, exactly
// as before), and written values go in as one JSON document that Postgres
// coerces column by column (`json_populate_recordset`), so a jsonb column
// takes an array and a text[] column takes a list without per-column code.
//
// Supported, because the backend uses it: select lists of plain columns
// (`*`, `a, b`, `alias:col`), count "exact" with or without head; insert,
// upsert (onConflict, ignoreDuplicates), update and delete, each with an
// optional `.select()`; eq, neq, gt, gte, lt, lte, like, ilike, is, in,
// not(col, "is"|"eq"|"in", v), match, filter, and `or("a.eq.x,b.is.null")`;
// order (ascending, nullsFirst), limit, range; single and maybeSingle; and
// rpc. Anything else fails loudly as an error result instead of guessing.

/** Runs one parameterized statement and returns its rows. */
export type Executor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** The error shape postgrest-js returns: a plain object, never thrown. */
export type DbError = {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
};

export type DbResult<T = any> = {
  data: T;
  error: DbError | null;
  count: number | null;
  status: number;
  statusText: string;
};

type Filter = { sql: (column: (name: string) => string, param: (value: unknown) => string) => string };
type Order = { column: string; ascending: boolean; nullsFirst?: boolean };
type Write =
  | { kind: "insert"; rows: Record<string, unknown>[] }
  | { kind: "upsert"; rows: Record<string, unknown>[]; onConflict?: string; ignoreDuplicates: boolean }
  | { kind: "update"; values: Record<string, unknown> }
  | { kind: "delete" };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

class UnsupportedQuery extends Error {}

function ident(name: string): string {
  const trimmed = name.trim();
  if (!IDENTIFIER.test(trimmed)) throw new UnsupportedQuery(`Unsupported identifier: ${JSON.stringify(name)}`);
  return `"${trimmed}"`;
}

/**
 * A select list as SQL: `*`, plain columns, and `alias:column`. `qualifier`
 * prefixes each column (an UPDATE … FROM has two relations with the same
 * column names).
 */
function selectList(columns: string, qualifier = ""): string {
  const prefix = qualifier ? `${qualifier}.` : "";
  const parts = columns
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return `${prefix}*`;
  return parts
    .map((part) => {
      if (part === "*") return `${prefix}*`;
      const alias = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
      if (alias) return `${prefix}${ident(alias[2])} AS ${ident(alias[1])}`;
      if (!IDENTIFIER.test(part)) {
        throw new UnsupportedQuery(`Unsupported select item: ${JSON.stringify(part)} (embeds and casts are not supported)`);
      }
      return qualifier ? `${prefix}${ident(part)} AS ${ident(part)}` : ident(part);
    })
    .join(", ");
}

/** A value bound as a parameter: objects (jsonb) as JSON text, the rest as pg serializes them. */
function bindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
};

/** `is` takes null, true, false (and their PostgREST spellings). */
function isTarget(value: unknown): string {
  if (value === null || value === "null") return "NULL";
  if (value === true || value === "true") return "TRUE";
  if (value === false || value === "false") return "FALSE";
  if (value === "unknown") return "UNKNOWN";
  throw new UnsupportedQuery(`Unsupported is() value: ${JSON.stringify(value)}`);
}

/** The values of PostgREST's `in.(a,b,"c,d")` list syntax. */
function listValues(text: string): string[] {
  const inner = text.trim().replace(/^\(/, "").replace(/\)$/, "");
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else current += char;
  }
  if (inner.length > 0) values.push(current);
  return values.map((value) => value.trim());
}

function comparison(columnName: string, operator: string, value: unknown, negate = false): Filter {
  return {
    sql: (column, param) => {
      const target = column(columnName);
      let clause: string;
      if (operator in COMPARISONS) clause = `${target} ${COMPARISONS[operator]} ${param(bindable(value))}`;
      else if (operator === "is") clause = `${target} IS ${isTarget(value)}`;
      else if (operator === "in") {
        const values = Array.isArray(value) ? value : listValues(String(value));
        clause = `${target} = ANY(${param(values.map(bindable))})`;
      } else throw new UnsupportedQuery(`Unsupported filter operator: ${operator}`);
      return negate ? `NOT (${clause})` : clause;
    },
  };
}

/** PostgREST's `or()` grammar, as far as the backend uses it: `col.op.value,…`. */
function orFilter(expression: string): Filter {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      terms.push(current);
      current = "";
    } else current += char;
  }
  if (current) terms.push(current);
  const filters = terms.map((term) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\.(not\.)?([a-z]+)\.([\s\S]*)$/.exec(term);
    if (!match) throw new UnsupportedQuery(`Unsupported or() term: ${JSON.stringify(term)}`);
    const [, columnName, not, operator, raw] = match;
    return comparison(columnName, operator, raw, Boolean(not));
  });
  return { sql: (column, param) => `(${filters.map((filter) => filter.sql(column, param)).join(" OR ")})` };
}

function failure(error: unknown): DbResult<null> {
  if (error instanceof UnsupportedQuery) {
    return { data: null, error: { message: error.message, details: null, hint: null, code: "MIKE_UNSUPPORTED_QUERY" }, count: null, status: 400, statusText: "Bad Request" };
  }
  const record = (error ?? {}) as { message?: unknown; detail?: unknown; hint?: unknown; code?: unknown };
  return {
    data: null,
    error: {
      message: typeof record.message === "string" ? record.message : String(error),
      details: typeof record.detail === "string" ? record.detail : null,
      hint: typeof record.hint === "string" ? record.hint : null,
      code: typeof record.code === "string" ? record.code : "",
    },
    count: null,
    status: 400,
    statusText: "Bad Request",
  };
}

const SINGLE_ROW = (rows: number): DbResult<null> => ({
  data: null,
  error: {
    message: "Cannot coerce the result to a single JSON object",
    details: `The result contains ${rows} rows`,
    hint: null,
    code: "PGRST116",
  },
  count: null,
  status: 406,
  statusText: "Not Acceptable",
});

const MAYBE_SINGLE_ROWS = (rows: number): DbResult<null> => ({
  data: null,
  error: {
    message: "JSON object requested, multiple (or no) rows returned",
    details: `Results contain ${rows} rows, application/vnd.pgrst.object+json requires 1 row`,
    hint: null,
    code: "PGRST116",
  },
  count: null,
  status: 406,
  statusText: "Not Acceptable",
});

/** Catalog facts the builder needs: a table's primary key, a function's signature. */
export class Catalog {
  private primaryKeys = new Map<string, Promise<string[]>>();
  private functions = new Map<string, Promise<FunctionInfo[]>>();

  constructor(private readonly execute: Executor) {}

  primaryKey(table: string): Promise<string[]> {
    let pending = this.primaryKeys.get(table);
    if (!pending) {
      pending = this.execute(
        `SELECT a.attname AS name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = to_regclass($1) AND i.indisprimary
          ORDER BY array_position(i.indkey, a.attnum)`,
        [`public.${ident(table)}`],
      ).then((rows) => rows.map((row) => String(row.name)));
      pending.catch(() => this.primaryKeys.delete(table));
      this.primaryKeys.set(table, pending);
    }
    return pending;
  }

  /** Every overload of a public function. */
  overloads(name: string): Promise<FunctionInfo[]> {
    let pending = this.functions.get(name);
    if (!pending) {
      pending = this.execute(
        `SELECT p.proretset AS returns_set,
                p.pronargs AS input_count,
                p.pronargdefaults AS default_count,
                t.typtype AS return_kind,
                format_type(p.prorettype, NULL) AS return_type,
                coalesce(p.proargnames, '{}') AS arg_names,
                coalesce(p.proargmodes::text[], '{}') AS arg_modes,
                ARRAY(SELECT format_type(x, NULL) FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) AS x) AS arg_types
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_type t ON t.oid = p.prorettype
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [name],
      ).then((rows) =>
        (rows as {
          returns_set: boolean;
          input_count: number;
          default_count: number;
          return_kind: string;
          return_type: string;
          arg_names: string[];
          arg_modes: string[];
          arg_types: string[];
        }[]).map((row) => {
          const args = new Map<string, string>();
          row.arg_types.forEach((type, index) => {
            const mode = row.arg_modes[index] ?? "i";
            const argName = row.arg_names[index];
            if (argName && (mode === "i" || mode === "b" || mode === "v")) args.set(argName, type);
          });
          // Defaults belong to the trailing input arguments.
          const inputs = [...args.keys()];
          const required = new Set(inputs.slice(0, Math.max(0, row.input_count - row.default_count)));
          return { returnsSet: row.returns_set, returnKind: row.return_kind, returnType: row.return_type, args, required };
        }),
      );
      pending.catch(() => this.functions.delete(name));
      this.functions.set(name, pending);
    }
    return pending;
  }
}

type FunctionInfo = {
  returnsSet: boolean;
  /** pg_type.typtype: b base, c composite, d domain, e enum, p pseudo. */
  returnKind: string;
  returnType: string;
  /** Input arguments by name, with their types. */
  args: Map<string, string>;
  /** Input arguments without a default. */
  required: Set<string>;
};

/**
 * The overload a call with these named arguments reaches, as PostgREST picks
 * it: every given name is an argument, every argument left out has a default,
 * and among those the one with the fewest arguments.
 */
function overloadFor(overloads: FunctionInfo[], names: string[]): FunctionInfo | undefined {
  return overloads
    .filter((info) => names.every((name) => info.args.has(name)) && [...info.required].every((name) => names.includes(name)))
    .sort((a, b) => a.args.size - b.args.size)[0];
}

/** Rows come back as `any[]`; after `single()`/`maybeSingle()`, one `any` row (as supabase-js typed them). */
export class QueryBuilder<Data = any[]> implements PromiseLike<DbResult<Data>> {
  private columns: string | undefined;
  private countExact = false;
  private head = false;
  private write: Write | undefined;
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limitCount: number | undefined;
  private offsetCount: number | undefined;
  private expect: "many" | "single" | "maybeSingle" = "many";
  private problem: UnsupportedQuery | undefined;

  constructor(
    private readonly execute: Executor,
    private readonly catalog: Catalog,
    private readonly table: string,
  ) {}

  select(columns = "*", options: { count?: "exact" | "planned" | "estimated"; head?: boolean } = {}): this {
    this.columns = columns;
    if (options.count) this.countExact = true;
    if (options.head) this.head = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.write = { kind: "insert", rows: Array.isArray(values) ? values : [values] };
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ): this {
    this.write = {
      kind: "upsert",
      rows: Array.isArray(values) ? values : [values],
      onConflict: options.onConflict,
      ignoreDuplicates: options.ignoreDuplicates === true,
    };
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.write = { kind: "update", values };
    return this;
  }

  delete(): this {
    this.write = { kind: "delete" };
    return this;
  }

  private add(filter: () => Filter): this {
    try {
      this.filters.push(filter());
    } catch (error) {
      this.problem ??= error instanceof UnsupportedQuery ? error : new UnsupportedQuery(String(error));
    }
    return this;
  }

  eq(column: string, value: unknown): this { return this.add(() => comparison(column, "eq", value)); }
  neq(column: string, value: unknown): this { return this.add(() => comparison(column, "neq", value)); }
  gt(column: string, value: unknown): this { return this.add(() => comparison(column, "gt", value)); }
  gte(column: string, value: unknown): this { return this.add(() => comparison(column, "gte", value)); }
  lt(column: string, value: unknown): this { return this.add(() => comparison(column, "lt", value)); }
  lte(column: string, value: unknown): this { return this.add(() => comparison(column, "lte", value)); }
  like(column: string, pattern: string): this { return this.add(() => comparison(column, "like", pattern)); }
  ilike(column: string, pattern: string): this { return this.add(() => comparison(column, "ilike", pattern)); }
  is(column: string, value: boolean | null): this { return this.add(() => comparison(column, "is", value)); }
  in(column: string, values: readonly unknown[]): this { return this.add(() => comparison(column, "in", [...values])); }
  not(column: string, operator: string, value: unknown): this {
    return this.add(() => comparison(column, operator, value, true));
  }
  filter(column: string, operator: string, value: unknown): this {
    const negated = operator.startsWith("not.");
    return this.add(() => comparison(column, negated ? operator.slice(4) : operator, value, negated));
  }
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) this.eq(column, value);
    return this;
  }
  or(expression: string): this { return this.add(() => orFilter(expression)); }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.orders.push({ column, ascending: options.ascending !== false, nullsFirst: options.nullsFirst });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single(): QueryBuilder<any> {
    this.expect = "single";
    return this as QueryBuilder<any>;
  }

  maybeSingle(): QueryBuilder<any> {
    this.expect = "maybeSingle";
    return this as QueryBuilder<any>;
  }

  then<TResult1 = DbResult<Data>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<Data>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return (this.run() as Promise<DbResult<Data>>).then(onfulfilled, onrejected);
  }

  private async run(): Promise<DbResult> {
    if (this.problem) return failure(this.problem);
    try {
      return await this.resolve();
    } catch (error) {
      return failure(error);
    }
  }

  private async resolve(): Promise<DbResult> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const table = ident(this.table);
    const column = (name: string) => `${table}.${ident(name)}`;
    const where = this.filters.length ? ` WHERE ${this.filters.map((filter) => filter.sql(column, param)).join(" AND ")}` : "";

    if (!this.write) {
      if (this.head) {
        const [row] = await this.execute(`SELECT count(*)::int AS count FROM ${table}${where}`, params);
        return { data: null, error: null, count: Number(row?.count ?? 0), status: 200, statusText: "OK" };
      }
      const order = this.orders.length
        ? ` ORDER BY ${this.orders
            .map((o) => `${ident(o.column)} ${o.ascending ? "ASC" : "DESC"}${o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST"}`)
            .join(", ")}`
        : "";
      const limit = this.limitCount !== undefined ? ` LIMIT ${Math.max(0, Math.floor(this.limitCount))}` : "";
      const offset = this.offsetCount !== undefined ? ` OFFSET ${Math.max(0, Math.floor(this.offsetCount))}` : "";
      const inner = `SELECT ${selectList(this.columns ?? "*")} FROM ${table}${where}${order}${limit}${offset}`;
      const [row] = await this.execute(`SELECT coalesce(json_agg(_r), '[]'::json) AS data FROM (${inner}) _r`, params);
      let count: number | null = null;
      if (this.countExact) {
        const filterParams: unknown[] = [];
        const countWhere = this.filters.length
          ? ` WHERE ${this.filters
              .map((filter) => filter.sql(column, (value) => {
                filterParams.push(value);
                return `$${filterParams.length}`;
              }))
              .join(" AND ")}`
          : "";
        const [counted] = await this.execute(`SELECT count(*)::int AS count FROM ${table}${countWhere}`, filterParams);
        count = Number(counted?.count ?? 0);
      }
      return this.shaped((row?.data ?? []) as unknown[], count, 200, "OK");
    }

    const returning = this.columns !== undefined ? ` RETURNING ${selectList(this.columns, table)}` : "";
    let statement: string;
    if (this.write.kind === "delete") {
      statement = `DELETE FROM ${table}${where}${returning}`;
    } else if (this.write.kind === "update") {
      const patch = this.write.values;
      const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
      if (keys.length === 0) throw new UnsupportedQuery("update() needs at least one column");
      const values = param(JSON.stringify(patch));
      statement = `UPDATE ${table} SET ${keys.map((key) => `${ident(key)} = _v.${ident(key)}`).join(", ")} FROM json_populate_record(NULL::${table}, ${values}::json) AS _v${where}${returning}`;
    } else {
      const rows = this.write.rows;
      if (rows.length === 0) return this.shaped([], null, 201, "Created");
      const keys = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined)))];
      if (keys.length === 0) throw new UnsupportedQuery("insert() needs at least one column");
      const list = keys.map(ident).join(", ");
      const values = param(JSON.stringify(rows));
      statement = `INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${table}, ${values}::json)`;
      if (this.write.kind === "upsert") {
        const target = this.write.onConflict
          ? this.write.onConflict.split(",").map((name) => ident(name))
          : (await this.catalog.primaryKey(this.table)).map((name) => ident(name));
        if (target.length === 0) throw new UnsupportedQuery(`upsert() on ${this.table} needs onConflict: it has no primary key`);
        const updates = keys.filter((key) => !target.includes(ident(key)));
        statement +=
          this.write.ignoreDuplicates || updates.length === 0
            ? ` ON CONFLICT (${target.join(", ")}) DO NOTHING`
            : ` ON CONFLICT (${target.join(", ")}) DO UPDATE SET ${updates.map((key) => `${ident(key)} = EXCLUDED.${ident(key)}`).join(", ")}`;
      }
      statement += returning;
    }

    const status = this.write.kind === "insert" || this.write.kind === "upsert" ? 201 : this.columns !== undefined ? 200 : 204;
    const statusText = status === 201 ? "Created" : status === 200 ? "OK" : "No Content";
    if (this.columns === undefined) {
      await this.execute(statement, params);
      return { data: null, error: null, count: null, status, statusText };
    }
    const [row] = await this.execute(`WITH _w AS (${statement}) SELECT coalesce(json_agg(_w), '[]'::json) AS data FROM _w`, params);
    return this.shaped((row?.data ?? []) as unknown[], null, status, statusText);
  }

  private shaped(rows: unknown[], count: number | null, status: number, statusText: string): DbResult {
    if (this.expect === "single") {
      if (rows.length !== 1) return SINGLE_ROW(rows.length);
      return { data: rows[0], error: null, count, status, statusText };
    }
    if (this.expect === "maybeSingle") {
      if (rows.length > 1) return MAYBE_SINGLE_ROWS(rows.length);
      return { data: rows[0] ?? null, error: null, count, status, statusText };
    }
    return { data: rows, error: null, count, status, statusText };
  }
}

/** `db.rpc(fn, args)`: a function called with named arguments, its result shaped as PostgREST shapes it. */
export class RpcBuilder implements PromiseLike<DbResult> {
  private expect: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private readonly execute: Executor,
    private readonly catalog: Catalog,
    private readonly name: string,
    private readonly args: object,
  ) {}

  single(): this {
    this.expect = "single";
    return this;
  }

  maybeSingle(): this {
    this.expect = "maybeSingle";
    return this;
  }

  then<TResult1 = DbResult, TResult2 = never>(
    onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<DbResult> {
    try {
      const given = Object.entries(this.args as Record<string, unknown>).filter(([, value]) => value !== undefined);
      const info = overloadFor(await this.catalog.overloads(this.name), given.map(([argName]) => argName));
      if (!info) {
        return {
          data: null,
          error: {
            message: `Could not find the function public.${this.name} in the schema cache`,
            details: null,
            hint: null,
            code: "PGRST202",
          },
          count: null,
          status: 404,
          statusText: "Not Found",
        };
      }
      const params: unknown[] = [];
      const named = given
        .map(([argName, value]) => {
          const type = info.args.get(argName);
          if (!type) throw new UnsupportedQuery(`public.${this.name} has no argument ${argName}`);
          const json = type === "json" || type === "jsonb";
          params.push(value === null ? null : json ? JSON.stringify(value) : bindable(value));
          return `${ident(argName)} => $${params.length}::${type}`;
        });
      const call = `public.${ident(this.name)}(${named.join(", ")})`;
      let data: unknown;
      if (info.returnsSet) {
        const sql = info.returnKind === "c" || info.returnType === "record"
          ? `SELECT coalesce(json_agg(_r), '[]'::json) AS data FROM ${call} AS _r`
          : `SELECT coalesce(json_agg(_r._v), '[]'::json) AS data FROM ${call} AS _r(_v)`;
        const [row] = await this.execute(sql, params);
        data = row?.data ?? [];
      } else if (info.returnType === "void") {
        await this.execute(`SELECT ${call}`, params);
        data = null;
      } else if (info.returnKind === "c" || info.returnType === "record") {
        const [row] = await this.execute(`SELECT to_json(_r) AS data FROM ${call} AS _r`, params);
        data = row?.data ?? null;
      } else {
        const [row] = await this.execute(`SELECT to_json(${call}) AS data`, params);
        data = row?.data ?? null;
      }
      if (this.expect !== "many") {
        const rows = Array.isArray(data) ? data : data === null ? [] : [data];
        if (this.expect === "single" && rows.length !== 1) return SINGLE_ROW(rows.length);
        if (rows.length > 1) return MAYBE_SINGLE_ROWS(rows.length);
        data = rows[0] ?? null;
      }
      return { data, error: null, count: null, status: 200, statusText: "OK" };
    } catch (error) {
      return failure(error);
    }
  }
}

/** The handle every service takes as `db`. */
export class DbClient {
  private readonly catalog: Catalog;

  constructor(private readonly execute: Executor) {
    this.catalog = new Catalog(execute);
  }

  from(table: string): QueryBuilder {
    return new QueryBuilder(this.execute, this.catalog, table);
  }

  rpc(name: string, args: object = {}): RpcBuilder {
    return new RpcBuilder(this.execute, this.catalog, name, args);
  }
}
