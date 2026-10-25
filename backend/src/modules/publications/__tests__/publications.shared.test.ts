import { describe, expect, it } from "vitest";
import {
    TOKEN_RE,
    hashPassword,
    hashToken,
    linkTokenEntropyBits,
    newLegacyToken,
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

    it("makes word tokens that are valid DNS labels", () => {
        const tokens = new Set(Array.from({ length: 5000 }, () => newToken()));
        expect(tokens.size).toBe(5000);
        const arrangements = new Set<string>();
        let digits = 0;
        for (const t of tokens) {
            expect(t).toMatch(TOKEN_RE);
            expect(t.length).toBeLessThanOrEqual(63);
            expect(t).toMatch(/^[a-z0-9]+(-[a-z0-9]+){7}$/);
            const parts = t.split("-");
            const numbers = parts.filter((p) => /^[0-9]+$/.test(p));
            expect(numbers).toHaveLength(4);
            expect(parts.filter((p) => /^[a-z]+$/.test(p))).toHaveLength(4);
            for (const n of numbers) {
                expect(Number(n)).toBeLessThan(4096);
                expect(n).toBe(String(Number(n)));
                digits += n.length;
            }
            arrangements.add(parts.map((p) => (/^[0-9]/.test(p) ? "n" : "w")).join(""));
        }
        expect(arrangements.size).toBe(70);
        // Uniform in 0-4095 averages 3.73 digits a number.
        expect(digits / (tokens.size * 4)).toBeCloseTo(3.73, 1);
        expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("has about 100 bits of entropy", () => {
        expect(linkTokenEntropyBits()).toBeGreaterThan(100);
        expect(linkTokenEntropyBits(2048)).toBeGreaterThan(98);
    });

    it("accepts every shape of token and rejects malformed ones", () => {
        expect(newLegacyToken()).toMatch(TOKEN_RE);
        expect(newLegacyToken()).toHaveLength(26);
        for (const ok of [
            "34-chapeau-1207-shiso-calabaza-3981-mango-602",
            "chapeau-shiso-calabaza-mango-1-22-333-4095",
            "1-2-3-4-abc-def-ghi-jkl",
            "abc-1-def-2-ghi-3-jkl-4",
            "abcdefghij-klmnopqrst-uvwxyzabcd-efghijklmn-9999-0000-1234-5678",
            // The first word links: three words, two numbers.
            "34-chapeau-shiso-937-calabaza",
            "abc-def-ghi-12-345",
        ])
            expect(ok).toMatch(TOKEN_RE);
        for (const bad of [
            "",
            "34-chapeau-1207-shiso-calabaza-3981-mango",
            "34-chapeau-1207-shiso-calabaza-3981-mango-602-7",
            "34-chapeau-1207-shiso-calabaza-3981-mango-602-",
            "-34-chapeau-1207-shiso-calabaza-3981-mango-602",
            "34--chapeau-1207-shiso-calabaza-3981-mango-602",
            "abc-def-ghi-jkl-mno-1-2-3",
            "1-2-3-4-5-abc-def-ghi",
            "12345-chapeau-1207-shiso-calabaza-3981-mango-602",
            "ab-chapeau-1207-shiso-calabaza-3981-mango-602",
            "abcdefghijk-chapeau-1207-shiso-calabaza-3981-mango-602",
            "34-Chapeau-1207-shiso-calabaza-3981-mango-602",
            "34-chapeau-1207-shiso-calabaza-3981-mango-602.evil",
            "34_chapeau_1207_shiso_calabaza_3981_mango_602",
            "34-chapeau-shiso-9é7-calabaza",
            "1234-abc-def-5-ghi",
            "abcdefghijklmnopqrstuvwxy",
            "abcdefghijklmnopqrstuvwxyz1",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        ])
            expect(bad).not.toMatch(TOKEN_RE);
    });

    it("finds a word token in a subdomain or a path", () => {
        const word = "34-chapeau-shiso-937-calabaza";
        expect(tokenFromRequest(enabled(), `${word}.pub.example.com`, "/x.png")).toMatchObject({ token: word, path: "x.png" });
        expect(tokenFromRequest(enabled(), `${word}.pub.example.com`, "/")).toMatchObject({ token: word });
        expect(tokenFromRequest(enabled(), `${word}x.evil.com`, "/")).toBeNull();
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
