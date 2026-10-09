import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

/** GoTrue's API with the service role: token checks, user lookups, account deletion. */
export type AuthAdmin = SupabaseClient["auth"];

let cachedAuthAdmin: { url: string; key: string; auth: AuthAdmin } | undefined;

export function authAdmin(): AuthAdmin {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  }
  if (cachedAuthAdmin?.url === url && cachedAuthAdmin.key === key) {
    return cachedAuthAdmin.auth;
  }
  const { auth } = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  cachedAuthAdmin = { url, key, auth };
  return auth;
}
