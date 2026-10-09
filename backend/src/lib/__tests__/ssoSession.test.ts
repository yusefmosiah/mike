import type { Request, Response as ExpressResponse } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestAuth } from "../authSession";

// Exercise the real GoTrue client; only the upstream HTTP boundary is mocked.
describe("SSO PKCE session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a PKCE challenge and persists an HttpOnly verifier for the callback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://auth.example.test");
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://idp.example/saml" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const headers: Record<string, unknown> = {};
    const req = {
      headers: { cookie: "" },
      get: vi.fn((name: string) =>
        name.toLowerCase() === "origin"
          ? "https://app.example.test"
          : undefined,
      ),
    } as unknown as Request;
    const res = {
      getHeader: (name: string) => headers[name],
      setHeader: vi.fn((name: string, value: unknown) => {
        headers[name] = value;
      }),
    } as unknown as ExpressResponse;
    const client = createRequestAuth(req, res);
    const { data, error } = await client.signInWithSSO({
      domain: "example.com",
      options: {
        redirectTo: "https://app.example.test/auth/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(error).toBeNull();
    expect(data).toEqual({ url: "https://idp.example/saml" });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://auth.example.test/sso");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      domain: "example.com",
      skip_http_redirect: true,
      code_challenge_method: "s256",
    });
    expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.redirect_to).toContain(
      "https://app.example.test/auth/callback",
    );
    const cookies = (headers["Set-Cookie"] as string[] | undefined) ?? [];
    const verifier = cookies.find((cookie) =>
      cookie.includes("-code-verifier="),
    );
    expect(verifier).toContain("__Host-mike-session");
    expect(verifier).toContain("HttpOnly");
    expect(verifier).toContain("Secure");
    expect(verifier).toContain("SameSite=Lax");
    expect(verifier).toContain("Path=/");
  });
});
