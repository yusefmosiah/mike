// The auth server: GoTrue, reached directly. Mike talks to it through its own
// client library (@supabase/auth-js); nothing else of Supabase is involved.
import { GoTrueClient, type SupportedStorage } from "@supabase/auth-js";
import { authServerConfiguration } from "./runtimeConfig";

/** A GoTrue client: user calls on one request's session. */
export type AuthClient = GoTrueClient;

/** GoTrue's API with the service role: token checks, user lookups, account deletion. */
export type AuthAdmin = GoTrueClient;

/**
 * A client for one request's session, kept in `storage` (the request's
 * cookies). PKCE, and no background refresh: a request handler is short-lived.
 */
export function createAuthClient(storage: SupportedStorage, storageKey: string): AuthClient {
  const { url } = authServerConfiguration();
  if (!url) throw new Error("AUTH_URL must be set");
  return new GoTrueClient({
    url,
    storage,
    storageKey,
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    skipAutoInitialize: true,
  });
}

let cachedAuthAdmin: { url: string; key: string; auth: AuthAdmin } | undefined;

export function authAdmin(): AuthAdmin {
  const { url, serviceKey: key } = authServerConfiguration();
  if (!url || !key) {
    throw new Error("AUTH_URL and AUTH_SERVICE_KEY must be set");
  }
  if (cachedAuthAdmin?.url === url && cachedAuthAdmin.key === key) {
    return cachedAuthAdmin.auth;
  }
  const auth = new GoTrueClient({
    url,
    headers: { Authorization: `Bearer ${key}` },
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });
  cachedAuthAdmin = { url, key, auth };
  return auth;
}

/**
 * GoTrue builds an OAuth authorize URL from the base this process reaches it
 * at; the browser has to follow it from the public base instead.
 */
export function browserAuthUrl(url: string): string {
  const { url: internal, publicUrl } = authServerConfiguration();
  if (!internal || publicUrl === internal || !url.startsWith(`${internal}/`)) return url;
  return `${publicUrl}${url.slice(internal.length)}`;
}
