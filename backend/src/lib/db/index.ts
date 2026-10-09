// The process's Postgres pool and the `Db` handle built on it. Every service
// takes a `Db`; route handlers and jobs obtain the shared one from `createDb()`.
import { Pool } from "pg";
import { databaseUrl } from "../runtimeConfig";
import { DbClient, type Executor } from "./client";

export { DbClient, type DbError, type DbResult, type Executor } from "./client";

let pool: Pool | undefined;
let client: DbClient | undefined;

/** The shared pool: one per process, opened on first use. */
export function databasePool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL must be set");
  pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    // A dropped idle connection is replaced on next use; it must not crash the process.
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (error) => {
    console.error("[db] idle connection error", error.message);
  });
  return pool;
}

const execute: Executor = async (sql, params) => (await databasePool().query(sql, params)).rows;

/** The shared database handle. */
export function createDb(): DbClient {
  client ??= new DbClient(execute);
  return client;
}

/** Close the pool (process shutdown, tests). */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  client = undefined;
  await current?.end();
}
