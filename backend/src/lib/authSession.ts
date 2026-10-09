import type { Request, Response } from "express";
import { parse, serialize, type SerializeOptions } from "cookie";
import type { SupportedStorage, User } from "@supabase/auth-js";
import { createAuthClient, type AuthClient } from "./gotrue";
import { requestOriginIsWordAddin } from "./origins";

const AUTH_COOKIE_BASE_NAME = "mike-session";
const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";

export function authCookiesAreSecure(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "production";
}

export function authCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return `${authCookiesAreSecure(env) ? "__Host-" : ""}${AUTH_COOKIE_BASE_NAME}`;
}

type CookieOptions = Pick<
  SerializeOptions,
  "httpOnly" | "secure" | "sameSite" | "path" | "partitioned"
>;

function requestCookieOptions(req: Request): CookieOptions {
  const wordAddin = requestOriginIsWordAddin(req.get("origin"));
  return {
    httpOnly: true,
    secure: wordAddin || authCookiesAreSecure(),
    sameSite: wordAddin ? "none" : "lax",
    path: "/",
    partitioned: wordAddin || undefined,
  };
}

function belongsToAuthStorage(name: string, baseName: string): boolean {
  return (
    name === baseName ||
    name.startsWith(`${baseName}.`) ||
    name.startsWith(`${baseName}-`)
  );
}

export function clearRequestAuthCookies(req: Request, res: Response): void {
  const baseName = authCookieName();
  const cookieOptions = requestCookieOptions(req);
  for (const name of Object.keys(parse(req.headers.cookie ?? ""))) {
    if (!belongsToAuthStorage(name, baseName)) continue;
    res.append(
      "Set-Cookie",
      serialize(name, "", { ...cookieOptions, maxAge: 0, expires: new Date(0) }),
    );
  }
  res.setHeader("Cache-Control", NO_STORE);
}

// The cookie format is the one @supabase/ssr wrote, so sessions issued before
// Mike talked to GoTrue directly stay valid: each stored item is `base64-` +
// base64url(value), split into `<key>.0`, `<key>.1`, ... past 3180 characters.
const BASE64_PREFIX = "base64-";
const MAX_CHUNK_SIZE = 3180;
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function isChunkOf(name: string, key: string): boolean {
  if (name === key) return true;
  return name.startsWith(`${key}.`) && /^(0|[1-9][0-9]*)$/.test(name.slice(key.length + 1));
}

function encodeChunks(key: string, value: string): Map<string, string> {
  const encoded = BASE64_PREFIX + Buffer.from(value, "utf8").toString("base64url");
  if (encoded.length <= MAX_CHUNK_SIZE) return new Map([[key, encoded]]);
  const chunks = new Map<string, string>();
  for (let i = 0; i * MAX_CHUNK_SIZE < encoded.length; i++) {
    chunks.set(`${key}.${i}`, encoded.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE));
  }
  return chunks;
}

function decodeChunks(key: string, cookies: Record<string, string | undefined>): string | null {
  let value = cookies[key] || null;
  if (!value) {
    const chunks: string[] = [];
    for (let i = 0; cookies[`${key}.${i}`]; i++) chunks.push(cookies[`${key}.${i}`]!);
    value = chunks.length ? chunks.join("") : null;
  }
  if (!value?.startsWith(BASE64_PREFIX)) return value;
  const decoded = Buffer.from(value.slice(BASE64_PREFIX.length), "base64url").toString("utf8");
  try {
    // Chunks from two different writes do not decode to JSON: treat as absent.
    JSON.parse(decoded);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * GoTrue session storage over one request's cookies. Writes go out as
 * Set-Cookie on the response straight away; a later write to the same cookie
 * in the same request replaces the earlier header rather than adding to it.
 */
class RequestCookieStorage implements SupportedStorage {
  readonly isServer = true;
  private readonly incoming: Record<string, string | undefined>;
  private readonly items = new Map<string, string | null>();
  private readonly outgoing = new Map<string, string>();

  constructor(
    req: Request,
    private readonly res: Response,
    private readonly options: CookieOptions,
  ) {
    this.incoming = parse(req.headers.cookie ?? "");
  }

  getItem(key: string): string | null {
    if (this.items.has(key)) return this.items.get(key)!;
    return decodeChunks(key, this.incoming);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
    this.write(key, encodeChunks(key, value));
  }

  removeItem(key: string): void {
    this.items.set(key, null);
    this.write(key, new Map());
  }

  private write(key: string, chunks: Map<string, string>) {
    const known = [...Object.keys(this.incoming), ...this.outgoing.keys()];
    for (const name of new Set(known)) {
      if (isChunkOf(name, key) && !chunks.has(name)) {
        this.set(name, "", 0);
      }
    }
    for (const [name, value] of chunks) {
      if (this.incoming[name] === value && !this.outgoing.has(name)) continue;
      this.set(name, value, COOKIE_MAX_AGE_SECONDS);
    }
  }

  private set(name: string, value: string, maxAge: number) {
    this.outgoing.set(name, serialize(name, value, { ...this.options, maxAge }));
    const existing = this.res.getHeader("Set-Cookie");
    const others = (Array.isArray(existing) ? existing : existing ? [String(existing)] : [])
      .filter((cookie) => !this.outgoing.has(cookie.slice(0, cookie.indexOf("="))));
    this.res.setHeader("Set-Cookie", [...others, ...this.outgoing.values()]);
    this.res.setHeader("Cache-Control", NO_STORE);
    this.res.setHeader("Expires", "0");
    this.res.setHeader("Pragma", "no-cache");
  }
}

/**
 * A GoTrue client for one HTTP request. Session and PKCE state are stored only
 * in server-set HttpOnly cookies; no browser auth client is involved.
 */
export function createRequestAuth(req: Request, res: Response): AuthClient {
  return createAuthClient(
    new RequestCookieStorage(req, res, requestCookieOptions(req)),
    authCookieName(),
  );
}

export interface PublicAuthUser {
  id: string;
  email: string;
  pendingEmail: string | null;
  createdWithGoogle: boolean;
}

export function publicAuthUser(user: User): PublicAuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    pendingEmail: user.new_email ?? null,
    createdWithGoogle: user.app_metadata?.provider === "google",
  };
}
