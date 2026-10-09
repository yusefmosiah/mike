import { describe, expect, it } from "vitest";
import { DbClient } from "./client";

/** A client that records statements and answers with `rows`. */
function recording(rows: Record<string, unknown>[] = [{ data: [] }]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = new DbClient(async (sql, params) => {
    statements.push({ sql, params });
    return rows;
  });
  return { db, statements };
}

describe("DbClient", () => {
  it("binds every value as a parameter and quotes every identifier", async () => {
    const { db, statements } = recording();
    await db.from("chats").select("id, title").eq("title", "x'; DROP TABLE chats; --").in("id", ["a", "b"]);
    expect(statements[0].sql).toBe(
      `SELECT coalesce(json_agg(_r), '[]'::json) AS data FROM (SELECT "id", "title" FROM "chats" WHERE "chats"."title" = $1 AND "chats"."id" = ANY($2)) _r`,
    );
    expect(statements[0].params).toEqual(["x'; DROP TABLE chats; --", ["a", "b"]]);
  });

  it("refuses what it does not support instead of guessing, without touching the database", async () => {
    const { db, statements } = recording();
    for (const query of [
      db.from("tools").select("*, connectors!inner(*)"),
      db.from("chats").select('id"; DROP TABLE chats; --'),
      db.from("chats; DROP TABLE chats").select("id"),
      db.from("chats").select("id").or("and(a.eq.1,b.eq.2)"),
      db.from("chats").select("id").is("title", "maybe" as never),
    ]) {
      const result = await query;
      expect(result.data).toBeNull();
      expect(result.error).toMatchObject({ code: "MIKE_UNSUPPORTED_QUERY" });
    }
    expect(statements).toHaveLength(0);
  });

  it("sends a write's values as one JSON document for Postgres to coerce per column", async () => {
    const { db, statements } = recording();
    await db.from("chat_messages").insert({ id: "m1", content: [{ type: "content", text: "hi" }], files: undefined });
    expect(statements[0].sql).toBe(
      `INSERT INTO "chat_messages" ("id", "content") SELECT "id", "content" FROM json_populate_recordset(NULL::"chat_messages", $1::json)`,
    );
    expect(JSON.parse(statements[0].params[0] as string)).toEqual([{ id: "m1", content: [{ type: "content", text: "hi" }] }]);
  });

  it("shapes single and maybeSingle as postgrest-js does", async () => {
    const none = recording([{ data: [] }]).db;
    expect((await none.from("chats").select("id").single()).error).toMatchObject({ code: "PGRST116" });
    expect(await none.from("chats").select("id").maybeSingle()).toMatchObject({ data: null, error: null });
    const two = recording([{ data: [{ id: 1 }, { id: 2 }] }]).db;
    expect((await two.from("chats").select("id").maybeSingle()).error).toMatchObject({ code: "PGRST116" });
  });

  it("reports a database error as a postgrest-style error result, never a throw", async () => {
    const db = new DbClient(async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", detail: "Key (id)=(1) already exists." });
    });
    const result = await db.from("chats").insert({ id: "1" });
    expect(result).toMatchObject({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint", details: "Key (id)=(1) already exists." },
    });
  });
});
