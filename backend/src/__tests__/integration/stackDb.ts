import { Pool } from "pg";
import { DbClient } from "../../lib/db/client";

// The stack suites' database handle: Mike's own client on the stack's
// Postgres (DATABASE_TEST_URL, set by scripts/test-stack.sh), the same path
// production queries take.
const databaseUrl = process.env.DATABASE_TEST_URL;

let pool: Pool | undefined;

/** Mike's client on the stack database, or null when the stack is not configured. */
export function stackDb(): DbClient | null {
  if (!databaseUrl) return null;
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  const current = pool;
  return new DbClient(async (sql, params) => (await current.query(sql, params)).rows);
}

export async function closeStackDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
