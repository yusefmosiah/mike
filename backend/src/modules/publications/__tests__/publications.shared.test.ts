import { describe, expect, it } from "vitest";
import {
    TOKEN_RE,
    hashPassword,
    hashToken,
    newToken,
    publicationUrl,
    publishingConfig,
    sealToken,
    tokenFromRequest,
    unlockCookieValid,
    unlockCookieValue,
    unsealToken,
    verifyPassword,
} from "../publications.shared";

const SECRET = "s".repeat(40);
const env = (extra: Record<string, string>) =>
    ({ AUTH_HANDOFF_ENCRYPTION_SECRET: SECRET, ...extra }) as NodeJS.ProcessEnv;

function enabled(extra: Record<string, string> = {}) {
    const config = publishingConfig(
        env({ PUBLISHING: "open", PUBLICATION_BASE_URL: "https://pub.example.com", ...extra }),
    );
    if (!config.enabled) throw new Error("expected publishing on");
    return config;
}

describe("publishingConfig", () => {
    it("is off unless the deployment opens it and names the content origin", () => {
        expect(publishingConfig(env({}))).toMatchObject({ enabled: false, reason: "off" });
        expect(publishingConfig(env({ PUBLISHING: "open" }))).toMatchObject({
            enabled: false,
            reason: "no_content_origin",
        });
        expect(publishingConfig(env({ PUBLISHING: "open", PUBLICATION_BASE_URL: "ftp://x" }))).toMatchObject({
            reason: "no_content_origin",
        });
        expect(publishingConfig(env({ PUBLISHING: "open", PUBLICATION_BASE_URL: "not a url" }))).toMatchObject({
            reason: "no_content_origin",
        });
        expect(
            publishingConfig({ PUBLISHING: "open", PUBLICATION_BASE_URL: "https://pub.example.com" } as NodeJS.ProcessEnv),
        ).toMatchObject({ enabled: false, reason: "no_secret" });
        expect(
            publishingConfig({
                PUBLISHING: "open",
                PUBLICATION_BASE_URL: "https://pub.example.com",
                PUBLICATION_SECRET: "p".repeat(32),
            } as NodeJS.ProcessEnv),
        ).toMatchObject({ enabled: true });
        expect(enabled()).toMatchObject({ enabled: true, audiences: ["public", "password"], style: "subdomain" });
    });

    it("is refused in strict private mode whatever else is set", () => {
        expect(
            publishingConfig(
                env({ STRICT_PRIVATE_MODE: "true", PUBLISHING: "open", PUBLICATION_BASE_URL: "https://pub.example.com" }),
            ),
        ).toMatchObject({ enabled: false, reason: "strict_private" });
    });
});

describe("links", () => {
    const token = "abcdefghijklmnopqrstuvwxyz";

    it("puts the token in a subdomain by default", () => {
        const config = enabled();
        expect(publicationUrl(config, token)).toBe(`https://${token}.pub.example.com/`);
        expect(tokenFromRequest(config, `${token}.pub.example.com`, "/img/a.png")).toEqual({
            token,
            path: "img/a.png",
            prefix: "/",
        });
        expect(tokenFromRequest(config, `${token}.PUB.example.com:443`, "/")).toMatchObject({ token, path: "" });
        expect(tokenFromRequest(config, "pub.example.com", "/")).toBeNull();
        expect(tokenFromRequest(config, "other.com", "/")).toBeNull();
        expect(tokenFromRequest(config, "short.pub.example.com", "/")).toBeNull();
    });

    it("puts the token in the path for a host without wildcard DNS", () => {
        const config = enabled({ PUBLICATION_URL_STYLE: "path", PUBLICATION_BASE_URL: "http://localhost:3002/p/" });
        expect(publicationUrl(config, token)).toBe(`http://localhost:3002/p/${token}/`);
        expect(tokenFromRequest(config, "localhost:3002", `/p/${token}/a/b.html`)).toEqual({
            token,
            path: "a/b.html",
            prefix: `/p/${token}/`,
        });
        expect(tokenFromRequest(config, "localhost:3002", `/p/${token}`)).toMatchObject({ path: "" });
        expect(tokenFromRequest(config, "localhost:3002", `/x/${token}/`)).toBeNull();
        expect(tokenFromRequest(config, "localhost:3002", "/p/NOT-A-TOKEN/")).toBeNull();
    });

    it("makes 128-bit tokens that are valid DNS labels", () => {
        const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
        expect(tokens.size).toBe(200);
        for (const t of tokens) expect(t).toMatch(TOKEN_RE);
        expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("seals a token so only the server key opens it", () => {
        process.env.PUBLICATION_SECRET = SECRET;
        const sealed = sealToken(token);
        expect(sealed).not.toContain(token);
        expect(unsealToken(sealed)).toBe(token);
        const tampered = Buffer.from(sealed, "base64url");
        tampered[tampered.length - 1] ^= 1;
        expect(unsealToken(tampered.toString("base64url"))).toBeNull();
    });
});

describe("passwords and unlock cookies", () => {
    it("hashes with scrypt and checks in constant time", async () => {
        const stored = await hashPassword("correct horse battery");
        expect(stored).toMatch(/^scrypt\$131072\$8\$1\$/);
        expect(await verifyPassword("correct horse battery", stored)).toBe(true);
        expect(await verifyPassword("wrong horse battery", stored)).toBe(false);
        expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    });

    it("signs a cookie that a new password, tampering or time invalidates", () => {
        process.env.PUBLICATION_SECRET = SECRET;
        const row = { id: "pub-1", password_version: 0 };
        const now = Date.UTC(2026, 9, 24);
        const value = unlockCookieValue(row, now);
        expect(unlockCookieValid(row, value, now)).toBe(true);
        expect(unlockCookieValid({ ...row, password_version: 1 }, value, now)).toBe(false);
        expect(unlockCookieValid({ ...row, id: "pub-2" }, value, now)).toBe(false);
        expect(unlockCookieValid(row, value, now + 13 * 3600_000)).toBe(false);
        expect(unlockCookieValid(row, `${value}x`, now)).toBe(false);
        expect(unlockCookieValid(row, "garbage", now)).toBe(false);
        expect(unlockCookieValid(row, undefined, now)).toBe(false);
    });
});
