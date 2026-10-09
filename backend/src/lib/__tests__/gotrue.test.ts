import { beforeEach, describe, expect, it, vi } from "vitest";

const { GoTrueClient } = vi.hoisted(() => ({
  GoTrueClient: vi.fn(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    this.options = options;
  }),
}));

vi.mock("@supabase/auth-js", () => ({ GoTrueClient }));

import { authAdmin, browserAuthUrl } from "../gotrue";

const AUTH_KEYS = [
  "AUTH_URL",
  "AUTH_PUBLIC_URL",
  "AUTH_API_KEY",
  "AUTH_SERVICE_KEY",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
];

beforeEach(() => {
  GoTrueClient.mockClear();
  for (const key of AUTH_KEYS) delete process.env[key];
});

describe("authAdmin", () => {
  beforeEach(() => {
    process.env.AUTH_URL = `http://${crypto.randomUUID()}.auth.test`;
    process.env.AUTH_SERVICE_KEY = crypto.randomUUID();
  });

  it("talks to GoTrue itself with the service key, and reuses one client", () => {
    const first = authAdmin();
    expect(authAdmin()).toBe(first);
    expect(GoTrueClient).toHaveBeenCalledTimes(1);
    expect(GoTrueClient).toHaveBeenCalledWith({
      url: process.env.AUTH_URL,
      headers: {
        apikey: process.env.AUTH_SERVICE_KEY,
        Authorization: `Bearer ${process.env.AUTH_SERVICE_KEY}`,
      },
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
  });

  it("creates a new client when the configuration changes", () => {
    const first = authAdmin();
    process.env.AUTH_SERVICE_KEY = crypto.randomUUID();
    expect(authAdmin()).not.toBe(first);
    expect(GoTrueClient).toHaveBeenCalledTimes(2);
  });

  it("reaches the same GoTrue behind Supabase's gateway for a deployment still on SUPABASE_*", () => {
    delete process.env.AUTH_URL;
    delete process.env.AUTH_SERVICE_KEY;
    process.env.SUPABASE_URL = "https://project.supabase.test/";
    process.env.SUPABASE_SECRET_KEY = "secret";
    authAdmin();
    expect(GoTrueClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://project.supabase.test/auth/v1",
        headers: { apikey: "secret", Authorization: "Bearer secret" },
      }),
    );
  });

  it("rejects missing server configuration", () => {
    delete process.env.AUTH_URL;
    expect(() => authAdmin()).toThrow("AUTH_URL and AUTH_SERVICE_KEY must be set");
    expect(GoTrueClient).not.toHaveBeenCalled();
  });
});

describe("browserAuthUrl", () => {
  it("moves a GoTrue URL from the internal base to the public one", () => {
    process.env.AUTH_URL = "http://auth:9999";
    process.env.AUTH_PUBLIC_URL = "https://auth.example.test/";
    expect(browserAuthUrl("http://auth:9999/authorize?provider=google")).toBe(
      "https://auth.example.test/authorize?provider=google",
    );
    expect(browserAuthUrl("https://accounts.google.test/o/oauth2")).toBe(
      "https://accounts.google.test/o/oauth2",
    );
    // A look-alike host is not the internal base.
    expect(browserAuthUrl("http://auth:99990/authorize")).toBe("http://auth:99990/authorize");
  });

  it("leaves the URL alone when GoTrue has one base", () => {
    process.env.AUTH_URL = "https://auth.example.test";
    expect(browserAuthUrl("https://auth.example.test/authorize")).toBe(
      "https://auth.example.test/authorize",
    );
  });
});
