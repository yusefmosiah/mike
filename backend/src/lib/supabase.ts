import { createDb, type DbClient } from "./db";

/**
 * The server-side database handle every service function takes as its first
 * argument. One name for the whole backend: services and job handlers accept
 * a `Db`, route handlers obtain one from `createServerSupabase()` and pass it
 * down. Declaring the alias here keeps the seam explicit and lets tests
 * substitute a fake with a single cast.
 *
 * It is Mike's own client over a direct Postgres connection (lib/db), shaped
 * like the supabase-js query builder it replaced.
 */
export type Db = DbClient;

/** The shared database handle. Queries bypass RLS: use only after authorizing the caller. */
export function createServerSupabase(): Db {
  return createDb();
}
