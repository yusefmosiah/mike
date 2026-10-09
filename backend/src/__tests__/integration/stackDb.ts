import { GoTrueClient } from "@supabase/auth-js";
import { Pool } from "pg";
import { DbClient } from "../../lib/db/client";

// The stack suites' handles on a real Postgres + GoTrue (scripts/test-stack.sh
// starts both and sets these): Mike's own client on the database, the same
// path production queries take, and GoTrue for creating and signing in users.
const databaseUrl = process.env.DATABASE_TEST_URL;
const authUrl = process.env.AUTH_TEST_URL;
const authServiceKey = process.env.AUTH_TEST_SERVICE_KEY;

/** True when the stack is configured; the suites skip otherwise. */
export const stackConfigured = Boolean(databaseUrl && authUrl && authServiceKey);

let pool: Pool | undefined;

function stackPool(): Pool | null {
  if (!databaseUrl) return null;
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}

/** Mike's client on the stack database, or null when the stack is not configured. */
export function stackDb(): DbClient | null {
  const current = stackPool();
  if (!current) return null;
  return new DbClient(async (sql, params) => (await current.query(sql, params)).rows);
}

/** GoTrue with the service role: `admin.createUser`, `getUser(token)`. */
export function stackAuth(): GoTrueClient {
  return new GoTrueClient({
    url: authUrl!,
    headers: { apikey: authServiceKey!, Authorization: `Bearer ${authServiceKey}` },
    persistSession: false,
    autoRefreshToken: false,
  });
}

/** GoTrue as an end user signs in to it. */
export function stackUserAuth(): GoTrueClient {
  return new GoTrueClient({ url: authUrl!, persistSession: false, autoRefreshToken: false });
}

/**
 * Run `sql` the way PostgREST runs a request from a browser: as the `anon`
 * role, or as `authenticated` carrying the caller's JWT claims. Mike never
 * queries this way; a hosted Supabase still exposes these roles over its data
 * API, which is why every table must deny them. Rolled back either way.
 */
export async function asRole(
  role: "anon" | "authenticated",
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; code?: string }> {
  const client = await stackPool()!.connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('role', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('request.jwt.claim.sub', $3, true)`,
      [role, JSON.stringify(userId ? { sub: userId, role } : { role }), userId ?? ""],
    );
    return { rows: (await client.query(sql, params)).rows };
  } catch (error) {
    return { rows: [], code: (error as { code?: string }).code ?? "unknown" };
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

export async function closeStackDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
