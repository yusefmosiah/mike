import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authCookieName,
  authCookiesAreSecure,
  clearRequestAuthCookies,
  createRequestAuth,
  publicAuthUser,
} from "../authSession";

/** A response that keeps headers the way Express does. */
function fakeResponse() {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    setCookies: () => (headers["Set-Cookie"] as string[] | undefined) ?? [],
    getHeader: (name: string) => headers[name],
    setHeader: vi.fn((name: string, value: unknown) => {
      headers[name] = value;
    }),
    append: vi.fn(),
  };
}

function requestWithCookies(cookie: string, origin?: string) {
  return { headers: { cookie }, get: vi.fn().mockReturnValue(origin) } as never;
}

/** The storage GoTrue's client keeps its session and PKCE verifier in. */
function storageOf(client: unknown) {
  return (client as { storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } }).storage;
}

// What @supabase/ssr wrote before Mike talked to GoTrue directly: `base64-` +
// base64url(JSON), split into numbered chunks past 3180 characters.
function ssrCookies(name: string, value: string): string {
  const encoded = `base64-${Buffer.from(value, "utf8").toString("base64url")}`;
  if (encoded.length <= 3180) return `${name}=${encoded}`;
  const parts: string[] = [];
  for (let i = 0; i * 3180 < encoded.length; i++) {
    parts.push(`${name}.${i}=${encoded.slice(i * 3180, (i + 1) * 3180)}`);
  }
  return parts.join("; ");
}

const session = JSON.stringify({
  access_token: "a".repeat(5000),
  refresh_token: "refresh",
  user: { id: "user-1", email: "lawyer@example.com", user_metadata: { name: "Zoë ✓" } },
});

describe("backend-managed auth cookies", () => {
  beforeEach(() => {
    process.env.AUTH_URL = "https://auth.example.test";
    delete process.env.WORD_ADDIN_URL;
    process.env.NODE_ENV = "development";
  });

  it("uses a Secure __Host cookie in production", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(authCookiesAreSecure(env)).toBe(true);
    expect(authCookieName(env)).toBe("__Host-mike-session");
  });

  it("uses an unprefixed cookie for local development", () => {
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(authCookiesAreSecure(env)).toBe(false);
    expect(authCookieName(env)).toBe("mike-session");
  });

  it("forces HttpOnly, SameSite=Lax, Secure, and Path=/ on every session write", () => {
    process.env.NODE_ENV = "production";
    const res = fakeResponse();
    storageOf(createRequestAuth(requestWithCookies(""), res as never)).setItem(
      "__Host-mike-session",
      '"opaque-session"',
    );

    const [cookie] = res.setCookies();
    expect(cookie).toMatch(/^__Host-mike-session=base64-/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(res.headers["Cache-Control"]).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("uses partitioned SameSite=None cookies for the Word task pane", () => {
    process.env.NODE_ENV = "production";
    process.env.WORD_ADDIN_URL = "https://word.example.test";
    const res = fakeResponse();
    storageOf(
      createRequestAuth(requestWithCookies("", "https://word.example.test"), res as never),
    ).setItem("__Host-mike-session", '"opaque"');

    const [cookie] = res.setCookies();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
  });

  it("reads sessions and PKCE verifiers in the cookie format @supabase/ssr wrote", () => {
    const cookie = [
      ssrCookies("mike-session", session),
      ssrCookies("mike-session-code-verifier", '"verifier"'),
      "unrelated=keep",
    ].join("; ");
    expect(cookie).toContain("mike-session.1=");
    const storage = storageOf(createRequestAuth(requestWithCookies(cookie), fakeResponse() as never));
    expect(storage.getItem("mike-session")).toBe(session);
    expect(storage.getItem("mike-session-code-verifier")).toBe('"verifier"');
  });

  it("writes the same format, so the cookies round-trip", () => {
    const res = fakeResponse();
    storageOf(createRequestAuth(requestWithCookies(""), res as never)).setItem("mike-session", session);
    const cookie = res.setCookies().map((header) => header.split(";")[0]).join("; ");
    expect(cookie).toBe(ssrCookies("mike-session", session));
    const next = storageOf(createRequestAuth(requestWithCookies(cookie), fakeResponse() as never));
    expect(next.getItem("mike-session")).toBe(session);
  });

  it("treats chunks from two different writes as no session", () => {
    const older = ssrCookies("mike-session", session).split("; ");
    const newer = ssrCookies("mike-session", session.replace("refresh", "rotated")).split("; ");
    const mixed = [older[0], newer[1]].join("; ");
    const storage = storageOf(createRequestAuth(requestWithCookies(mixed), fakeResponse() as never));
    expect(storage.getItem("mike-session")).toBeNull();
  });

  it("replaces, rather than adds to, a cookie written twice in one request, and expires stale chunks", () => {
    const res = fakeResponse();
    res.headers["Set-Cookie"] = ["other=1; Path=/"];
    const storage = storageOf(
      createRequestAuth(requestWithCookies(ssrCookies("mike-session", session)), res as never),
    );
    storage.setItem("mike-session", '"short"');
    storage.setItem("mike-session", '"shorter"');

    const cookies = res.setCookies();
    expect(cookies[0]).toBe("other=1; Path=/");
    const byName = new Map(cookies.slice(1).map((header) => [header.slice(0, header.indexOf("=")), header]));
    expect([...byName.keys()].sort()).toEqual(["mike-session", "mike-session.0", "mike-session.1", "mike-session.2"]);
    expect(cookies.slice(1)).toHaveLength(4);
    expect(byName.get("mike-session")).toContain(
      `mike-session=base64-${Buffer.from('"shorter"').toString("base64url")}`,
    );
    for (const chunk of ["mike-session.0", "mike-session.1", "mike-session.2"]) {
      expect(byName.get(chunk)).toContain("Max-Age=0");
    }
    expect(storage.getItem("mike-session")).toBe('"shorter"');
  });

  it("expires every chunk when the session is removed, and reads it as gone", () => {
    const res = fakeResponse();
    const storage = storageOf(
      createRequestAuth(requestWithCookies(ssrCookies("mike-session", session)), res as never),
    );
    storage.removeItem("mike-session");
    expect(res.setCookies()).toHaveLength(3);
    for (const cookie of res.setCookies()) expect(cookie).toContain("Max-Age=0");
    expect(storage.getItem("mike-session")).toBeNull();
  });

  it("does not rewrite a cookie the browser already holds", () => {
    const res = fakeResponse();
    const cookie = ssrCookies("mike-session-code-verifier", '"verifier"');
    storageOf(createRequestAuth(requestWithCookies(cookie), res as never)).setItem(
      "mike-session-code-verifier",
      '"verifier"',
    );
    expect(res.setCookies()).toEqual([]);
  });

  it("expires every chunk belonging to the request session", () => {
    const append = vi.fn();
    const setHeader = vi.fn();
    const req = {
      headers: {
        cookie:
          "mike-session.0=first; unrelated=keep; mike-session.1=second; mike-session-code-verifier=pkce",
      },
      get: vi.fn().mockReturnValue(undefined),
    } as never;
    const res = { append, setHeader } as never;

    clearRequestAuthCookies(req, res);

    expect(append).toHaveBeenCalledTimes(3);
    expect(append.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("mike-session.0="),
      expect.stringContaining("mike-session.1="),
      expect.stringContaining("mike-session-code-verifier="),
    ]);
    for (const [, cookie] of append.mock.calls) {
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("returns only the user fields clients need", () => {
    expect(
      publicAuthUser({
        id: "user-1",
        email: "lawyer@example.com",
        new_email: "new@example.com",
        app_metadata: { provider: "google", secret: "hidden" },
        user_metadata: { private: "hidden" },
      } as never),
    ).toEqual({
      id: "user-1",
      email: "lawyer@example.com",
      pendingEmail: "new@example.com",
      createdWithGoogle: true,
    });
  });
});
