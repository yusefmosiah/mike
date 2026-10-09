import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbClient } from "../../lib/db/client";

// Gated: runs only against a real database (scripts/test-stack.sh).
// Mike's client replaced supabase-js + PostgREST. Every case's result is
// checked against the snapshot recorded from PostgREST v14.12, run through
// supabase-js on the same database, when the two were last side by side
// (__snapshots__/dbClient.conformance.stack.test.ts.snap); a case added since
// records Mike's own answer.
const databaseUrl = process.env.DATABASE_TEST_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

const TABLE = "mike_db_conformance";

maybeDescribe("Mike's database client answers as PostgREST did", () => {
  let pool: Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = new DbClient(async (sql, params) => (await pool.query(sql, params)).rows);
    await pool.query(`
      DROP TABLE IF EXISTS public.${TABLE};
      CREATE TABLE public.${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        n integer,
        big bigint,
        amount numeric,
        flag boolean,
        tags text[],
        meta jsonb,
        events jsonb,
        kind text,
        created_at timestamptz NOT NULL DEFAULT '2026-10-08T12:00:00Z',
        UNIQUE (name, kind)
      );
      CREATE OR REPLACE FUNCTION public.${TABLE}_names(p_kind text) RETURNS SETOF text
        LANGUAGE sql STABLE AS $$ SELECT name FROM public.${TABLE} WHERE kind = p_kind ORDER BY name $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_rows(p_min integer) RETURNS SETOF public.${TABLE}
        LANGUAGE sql STABLE AS $$ SELECT * FROM public.${TABLE} WHERE n >= p_min ORDER BY n $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_table(p_ids uuid[]) RETURNS TABLE(id uuid, label text)
        LANGUAGE sql STABLE AS $$ SELECT id, upper(name) FROM public.${TABLE} WHERE id = ANY(p_ids) ORDER BY name $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_count(p_kind text) RETURNS integer
        LANGUAGE sql STABLE AS $$ SELECT count(*)::int FROM public.${TABLE} WHERE kind = p_kind $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_echo(p_doc jsonb, p_tags text[]) RETURNS jsonb
        LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('doc', p_doc, 'tags', to_jsonb(p_tags)) $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_touch(p_id uuid) RETURNS void
        LANGUAGE sql AS $$ UPDATE public.${TABLE} SET n = n + 1 WHERE id = p_id $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_pick(p_a integer) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT 'one:' || p_a $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_pick(p_a integer, p_b text) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT 'two:' || p_a || p_b $$;
      CREATE OR REPLACE FUNCTION public.${TABLE}_opt(p_a integer, p_b text DEFAULT 'd') RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT p_a || p_b $$;
    `);
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE;
      DROP FUNCTION IF EXISTS public.${TABLE}_names(text);
      DROP FUNCTION IF EXISTS public.${TABLE}_table(uuid[]);
      DROP FUNCTION IF EXISTS public.${TABLE}_count(text);
      DROP FUNCTION IF EXISTS public.${TABLE}_echo(jsonb, text[]);
      DROP FUNCTION IF EXISTS public.${TABLE}_touch(uuid);
      DROP FUNCTION IF EXISTS public.${TABLE}_pick(integer);
      DROP FUNCTION IF EXISTS public.${TABLE}_pick(integer, text);
      DROP FUNCTION IF EXISTS public.${TABLE}_opt(integer, text);`);
    await pool?.end();
  });

  const seed = [
    { id: "00000000-0000-4000-8000-000000000001", name: "alpha", n: 1, big: 9007199254740, amount: 12.5, flag: true, tags: ["a", "b"], meta: { k: 1 }, events: [{ type: "content", text: "hi" }], kind: "file" },
    { id: "00000000-0000-4000-8000-000000000002", name: "beta", n: 2, big: null, amount: null, flag: false, tags: [], meta: null, events: null, kind: null },
    { id: "00000000-0000-4000-8000-000000000003", name: "gamma", n: null, big: 3, amount: 0.1, flag: null, tags: null, meta: { nested: { x: [1, 2] } }, events: [], kind: "folder" },
  ];

  /** Run a chain on a freshly seeded table and shape its result for comparison. */
  async function run(build: (client: any) => PromiseLike<any>) {
    await pool.query(`DELETE FROM public.${TABLE}`);
    await (db as any).from(TABLE).insert(seed);
    const result = await build(db);
    return {
      data: result.data,
      count: result.count ?? null,
      error: result.error ? { code: result.error.code } : null,
    };
  }

  /** `unordered`: rows with no ORDER BY come back in whatever order the heap holds them. */
  async function same(build: (client: any) => PromiseLike<any>, options: { unordered?: boolean } = {}) {
    const mike = await run(build);
    if (options.unordered && Array.isArray(mike.data)) {
      mike.data.sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    expect(mike).toMatchSnapshot();
    return mike;
  }

  it("selects columns, aliases and every column type as PostgREST serializes them", async () => {
    const all = await same((c) => c.from(TABLE).select("*").order("name"));
    expect(all.data).toHaveLength(3);
    expect(all.data[0].created_at).toBe("2026-10-08T12:00:00+00:00");
    await same((c) => c.from(TABLE).select("id, label:name, tags, meta").order("name", { ascending: false }));
  });

  it("filters: eq, neq, gt/gte/lt/lte, in, is, not, like/ilike, match, or", async () => {
    await same((c) => c.from(TABLE).select("name").eq("kind", "file"));
    await same((c) => c.from(TABLE).select("name").neq("name", "alpha").order("name"));
    await same((c) => c.from(TABLE).select("name").gt("n", 1));
    await same((c) => c.from(TABLE).select("name").gte("n", 1).lte("n", 2).order("n"));
    await same((c) => c.from(TABLE).select("name").lt("amount", 1));
    await same((c) => c.from(TABLE).select("name").in("name", ["alpha", "gamma"]).order("name"));
    await same((c) => c.from(TABLE).select("name").in("name", []));
    await same((c) => c.from(TABLE).select("name").is("kind", null));
    await same((c) => c.from(TABLE).select("name").is("flag", true));
    await same((c) => c.from(TABLE).select("name").not("kind", "is", null).order("name"));
    await same((c) => c.from(TABLE).select("name").ilike("name", "%LP%"));
    await same((c) => c.from(TABLE).select("name").like("name", "g%"));
    await same((c) => c.from(TABLE).select("name").match({ kind: "folder" }).order("name"));
    await same((c) => c.from(TABLE).select("name").or("kind.eq.file,kind.is.null").order("name"));
    await same((c) => c.from(TABLE).select("name").in("id", [seed[0].id, seed[2].id]).or(`kind.is.null,kind.neq.file`));
    await same((c) => c.from(TABLE).select("name").filter("meta->>k", "eq", "1"));
    await same((c) => c.from(TABLE).select("name").eq("meta->nested->x->>1", "2"));
  });

  it("orders with nulls placement, limits and ranges", async () => {
    await same((c) => c.from(TABLE).select("name, n").order("n", { ascending: true, nullsFirst: true }));
    await same((c) => c.from(TABLE).select("name, n").order("n", { ascending: false, nullsFirst: false }));
    await same((c) => c.from(TABLE).select("name").order("name").limit(2));
    await same((c) => c.from(TABLE).select("name").order("name").range(1, 2));
  });

  it("single and maybeSingle, including their errors", async () => {
    await same((c) => c.from(TABLE).select("name").eq("name", "alpha").single());
    await same((c) => c.from(TABLE).select("name").eq("name", "nobody").single());
    await same((c) => c.from(TABLE).select("name").single());
    await same((c) => c.from(TABLE).select("name").eq("name", "nobody").maybeSingle());
    await same((c) => c.from(TABLE).select("name").eq("name", "beta").maybeSingle());
    await same((c) => c.from(TABLE).select("name").maybeSingle());
  });

  it("counts exactly, with and without rows", async () => {
    await same((c) => c.from(TABLE).select("id", { count: "exact", head: true }).not("kind", "is", null));
    await same((c) => c.from(TABLE).select("name", { count: "exact" }).order("name").limit(1));
  });

  it("inserts, with and without returning, and reports constraint violations", async () => {
    await same((c) => c.from(TABLE).insert({ name: "delta", kind: "file", tags: ["x"], events: [{ type: "content" }] }));
    await same((c) => c.from(TABLE).insert({ name: "delta", kind: "file", meta: { a: [1] } }).select("name, kind, meta").single());
    await same((c) => c.from(TABLE).insert([{ name: "e1", n: 5 }, { name: "e2", n: 6 }]).select("name, n"));
    await same((c) => c.from(TABLE).insert({ name: "alpha", kind: "file" }));
    await same((c) => c.from(TABLE).insert({ n: 1 }));
  });

  it("upserts on a named conflict target or the primary key, merging or ignoring", async () => {
    await same((c) => c.from(TABLE).upsert({ name: "alpha", kind: "file", n: 42 }, { onConflict: "name,kind" }).select("name, n"));
    await same((c) => c.from(TABLE).upsert({ name: "alpha", kind: "file", n: 42 }, { onConflict: "name,kind", ignoreDuplicates: true }).select("name, n"));
    await same((c) => c.from(TABLE).upsert({ id: seed[1].id, name: "beta2" }).select("id, name, n"));
    await same((c) => c.from(TABLE).upsert([{ name: "new", kind: "k", n: 1 }, { name: "beta", kind: "k", n: 2 }], { onConflict: "name,kind" }).select("name, n"));
  });

  it("updates and deletes, with and without returning", async () => {
    await same((c) => c.from(TABLE).update({ n: 7, meta: { changed: true }, tags: ["z"] }).eq("name", "alpha").select("name, n, meta, tags"));
    await same((c) => c.from(TABLE).update({ kind: null }).in("name", ["beta", "gamma"]));
    await same((c) => c.from(TABLE).update({ events: [{ type: "error", message: "m" }] }).eq("id", seed[0].id).select("events").single());
    await same((c) => c.from(TABLE).delete().eq("name", "beta"));
    await same((c) => c.from(TABLE).delete().or("kind.eq.file,kind.is.null").select("name"), { unordered: true });
  });

  it("calls functions: set of scalars, set of rows, table, scalar, jsonb, void, missing", async () => {
    await same((c) => c.rpc(`${TABLE}_names`, { p_kind: "file" }));
    await same((c) => c.rpc(`${TABLE}_rows`, { p_min: 1 }));
    await same((c) => c.rpc(`${TABLE}_table`, { p_ids: [seed[0].id, seed[1].id] }));
    await same((c) => c.rpc(`${TABLE}_count`, { p_kind: "file" }));
    await same((c) => c.rpc(`${TABLE}_echo`, { p_doc: { a: [1, { b: null }] }, p_tags: ["x", "y,z"] }));
    await same((c) => c.rpc(`${TABLE}_touch`, { p_id: seed[0].id }));
    await same((c) => c.rpc(`${TABLE}_table`, { p_ids: [seed[0].id] }).maybeSingle());
    // Overloads: the argument names pick the function; defaults may be left out.
    await same((c) => c.rpc(`${TABLE}_pick`, { p_a: 1 }));
    await same((c) => c.rpc(`${TABLE}_pick`, { p_a: 1, p_b: "x" }));
    await same((c) => c.rpc(`${TABLE}_opt`, { p_a: 2 }));
    await same((c) => c.rpc(`${TABLE}_opt`, { p_a: 2, p_b: "e" }));
    const missing = await same((c) => c.rpc(`${TABLE}_nope`, { p: 1 }));
    expect(missing.error).toEqual({ code: "PGRST202" });
  });
});
