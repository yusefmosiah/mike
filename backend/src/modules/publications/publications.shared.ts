// Shared pieces of the publications module (docs/publishing.md): the
// deployment's publishing policy, link tokens, the server key that seals them
// and signs unlock cookies, password hashing, and the headers published pages
// are served with. Topic files import these; the facade does not export them
// all.

import crypto from "node:crypto";
import { promisify } from "node:util";
import { isStrictPrivateMode } from "../../lib/privateMode";
import { authHandoffEncryptionSecret } from "../../lib/runtimeConfig";
import { LINK_WORDS } from "./linkWords";

export type PublicationAudience = "public" | "password";
export type PublicationKind = "site" | "file";

export type PublicationRow = {
    id: string;
    created_by: string | null;
    document_id: string | null;
    version_id: string | null;
    kind: PublicationKind;
    audience: PublicationAudience;
    token_hash: string;
    token_sealed: string;
    password_hash: string | null;
    password_version: number;
    require_sign_in: boolean;
    title: string;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
};

export const PUBLICATION_COLUMNS =
    "id, created_by, document_id, version_id, kind, audience, token_hash, token_sealed, password_hash, password_version, require_sign_in, title, expires_at, revoked_at, created_at";

export const MIN_PASSWORD_LENGTH = 12;
export const EXPIRY_DAYS = [7, 30, 90] as const;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PublishingConfig =
    | {
          enabled: true;
          audiences: PublicationAudience[];
          baseUrl: URL;
          /** The base URL's path without its trailing slash ("" at the root). */
          basePath: string;
          style: "subdomain" | "path";
      }
    | {
          enabled: false;
          audiences: [];
          reason: "off" | "strict_private" | "no_content_origin" | "no_secret";
      };

/**
 * Publishing is off unless the deployment opts in with PUBLISHING=open and
 * names the content origin in PUBLICATION_BASE_URL. Strict private mode
 * refuses it whatever the other settings say.
 */
export function publishingConfig(
    env: NodeJS.ProcessEnv = process.env,
): PublishingConfig {
    if (isStrictPrivateMode(env))
        return { enabled: false, audiences: [], reason: "strict_private" };
    if (env.PUBLISHING?.trim() !== "open")
        return { enabled: false, audiences: [], reason: "off" };
    const baseUrl = parseBaseUrl(env.PUBLICATION_BASE_URL);
    if (!baseUrl)
        return { enabled: false, audiences: [], reason: "no_content_origin" };
    if (!hasServerSecret(env))
        return { enabled: false, audiences: [], reason: "no_secret" };
    return {
        enabled: true,
        audiences: ["public", "password"],
        baseUrl,
        basePath: baseUrl.pathname.replace(/\/+$/, ""),
        style: env.PUBLICATION_URL_STYLE?.trim() === "path" ? "path" : "subdomain",
    };
}

function parseBaseUrl(raw: string | undefined): URL | null {
    if (!raw?.trim()) return null;
    try {
        const url = new URL(raw.trim());
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        url.search = "";
        url.hash = "";
        return url;
    } catch {
        return null;
    }
}

/**
 * A publication's address. With subdomains (the default) every publication
 * is its own origin, `https://<token>.<content host>/`, so one published page
 * cannot read another's storage. The path style, `https://<content host>/<token>/`,
 * is for a content host without wildcard DNS; its publications share an
 * origin, which is acceptable only while one person publishes.
 */
export function publicationUrl(
    config: Extract<PublishingConfig, { enabled: true }>,
    token: string,
): string {
    const { baseUrl, basePath } = config;
    if (config.style === "path") return `${baseUrl.origin}${basePath}/${token}/`;
    return `${baseUrl.protocol}//${token}.${baseUrl.host}${basePath}/`;
}

/**
 * The token a content request names, and the path inside the publication,
 * or null when the request is not for a publication.
 */
export function tokenFromRequest(
    config: Extract<PublishingConfig, { enabled: true }>,
    host: string,
    path: string,
): { token: string; path: string; prefix: string } | null {
    const { basePath } = config;
    if (!path.startsWith(`${basePath}/`)) return null;
    const rest = path.slice(basePath.length + 1);
    if (config.style === "path") {
        const slash = rest.indexOf("/");
        const token = slash === -1 ? rest : rest.slice(0, slash);
        if (!TOKEN_RE.test(token)) return null;
        return {
            token,
            path: slash === -1 ? "" : rest.slice(slash + 1),
            prefix: `${basePath}/${token}/`,
        };
    }
    const baseHost = config.baseUrl.hostname.toLowerCase();
    const hostname = host.toLowerCase().replace(/:\d+$/, "");
    if (!hostname.endsWith(`.${baseHost}`)) return null;
    const token = hostname.slice(0, -(baseHost.length + 1));
    if (!TOKEN_RE.test(token)) return null;
    return { token, path: rest, prefix: `${basePath}/` };
}

// ---------------------------------------------------------------------------
// Tokens and the server key
// ---------------------------------------------------------------------------

// Link names. The token is the only secret of an "anyone with the link"
// publication, and it is a DNS label (a subdomain), so it is at most 63
// characters of a-z, 0-9 and single hyphens.
//
// New tokens are three words and two numbers, hyphen-joined in one of ten
// arrangements (the numbers take two of the five places), such as
// `34-chapeau-shiso-937-calabaza`:
//   - each word is drawn uniformly from LINK_WORDS (>= 2048 words, so >= 11
//     bits each; log2 of the actual size is used below);
//   - each number is uniform in 0-999 (~9.97 bits each, written without
//     padding, so 7 and 007 are never both generated);
//   - the arrangement is uniform over the ten (~3.32 bits).
// That is >= 3 * 11 + 2 * 9.97 + 3.32 = 56.3 bits with the minimum list, and
// ~57.6 bits with the list as shipped (see linkTokenEntropyBits). All draws
// use crypto.randomInt (CSPRNG, unbiased). Guessing is limited by the miss
// throttle on the content server (publications.throttle.ts), not by the
// token alone.
//
// Tokens made before this change are 16 random bytes in lowercase base32: 26
// characters, 128 bits. They stay valid; TOKEN_RE accepts both shapes. It
// checks structure only, not word membership, so LINK_WORDS can grow.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const LEGACY_TOKEN = "[a-z2-7]{26}";

/** Where the two numbers sit among the five parts: every choice of two places. */
const NUMBER_PLACES: readonly (readonly [number, number])[] = [
    [0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4],
];

const WORD_PART = "[a-z]{3,10}";
const NUMBER_PART = "[0-9]{1,3}";

const WORD_TOKEN = NUMBER_PLACES.map(([a, b]) =>
    Array.from({ length: 5 }, (_, i) => (i === a || i === b ? NUMBER_PART : WORD_PART)).join("-"),
).join("|");

// 3 words + 2 numbers is at most 3 * 10 + 2 * 3 + 4 hyphens = 40 characters.
export const TOKEN_RE = new RegExp(`^(?:${LEGACY_TOKEN}|${WORD_TOKEN})$`);

/** Bits of entropy in a word token drawn from `wordCount` words. */
export function linkTokenEntropyBits(wordCount = LINK_WORDS.length): number {
    return 3 * Math.log2(wordCount) + 2 * Math.log2(1000) + Math.log2(NUMBER_PLACES.length);
}

export function newToken(): string {
    const [a, b] = NUMBER_PLACES[crypto.randomInt(NUMBER_PLACES.length)];
    return Array.from({ length: 5 }, (_, i) =>
        i === a || i === b
            ? String(crypto.randomInt(1000))
            : LINK_WORDS[crypto.randomInt(LINK_WORDS.length)],
    ).join("-");
}

/** The pre-word-link format: 128 random bits in base32. Kept for tests. */
export function newLegacyToken(): string {
    const bytes = crypto.randomBytes(16);
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function hasServerSecret(env: NodeJS.ProcessEnv): boolean {
    return [env.PUBLICATION_SECRET, env.AUTH_HANDOFF_ENCRYPTION_SECRET].some(
        (value) => (value?.trim().length ?? 0) >= 32,
    );
}

/**
 * PUBLICATION_SECRET, else AUTH_HANDOFF_ENCRYPTION_SECRET. Publishing is off
 * without one (publishingConfig), so a deployment never seals a token it
 * cannot open again.
 */
function serverSecret(env: NodeJS.ProcessEnv = process.env): string {
    const own = env.PUBLICATION_SECRET?.trim() ?? "";
    if (own.length >= 32) return own;
    return authHandoffEncryptionSecret(env);
}

const derivedKeys = new Map<string, Buffer>();

function derivedKey(purpose: "seal" | "cookie"): Buffer {
    const secret = serverSecret();
    const cacheKey = `${purpose}\0${secret}`;
    let key = derivedKeys.get(cacheKey);
    if (!key) {
        key = crypto.scryptSync(secret, `mike-publications-${purpose}-v1`, 32);
        derivedKeys.set(cacheKey, key);
    }
    return key;
}

/** The token, encrypted so a database leak alone yields no working link. */
export function sealToken(token: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey("seal"), iv);
    const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

export function unsealToken(sealed: string): string | null {
    try {
        const raw = Buffer.from(sealed, "base64url");
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            derivedKey("seal"),
            raw.subarray(0, 12),
        );
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([
            decipher.update(raw.subarray(28)),
            decipher.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Passwords and unlock cookies
// ---------------------------------------------------------------------------

const scrypt = promisify(crypto.scrypt) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: crypto.ScryptOptions,
) => Promise<Buffer>;

// OWASP's scrypt parameters: N=2^17, r=8, p=1.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 32, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(
    password: string,
    stored: string,
): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const expected = Buffer.from(hash, "base64url");
    const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(actual, expected);
}

export const UNLOCK_COOKIE = "pub_unlock";
export const UNLOCK_TTL_SECONDS = 12 * 60 * 60;

function unlockMac(row: Pick<PublicationRow, "id" | "password_version">, expires: number) {
    return crypto
        .createHmac("sha256", derivedKey("cookie"))
        .update(`${row.id}\0${row.password_version}\0${expires}`)
        .digest("base64url");
}

/** Signed with the server key; a new password invalidates every cookie. */
export function unlockCookieValue(
    row: Pick<PublicationRow, "id" | "password_version">,
    now = Date.now(),
): string {
    const expires = Math.floor(now / 1000) + UNLOCK_TTL_SECONDS;
    return `${expires}.${unlockMac(row, expires)}`;
}

export function unlockCookieValid(
    row: Pick<PublicationRow, "id" | "password_version">,
    value: string | undefined,
    now = Date.now(),
): boolean {
    if (!value) return false;
    const [expiresRaw, mac] = value.split(".");
    const expires = Number(expiresRaw);
    if (!Number.isInteger(expires) || !mac) return false;
    if (expires * 1000 <= now) return false;
    const expected = Buffer.from(unlockMac(row, expires));
    const actual = Buffer.from(mac);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Signed-in links
// ---------------------------------------------------------------------------
//
// The content origin never sees the app's session. A signed-in-only link
// sends its visitor to the app (/published), which checks they can open the
// document and hands back a grant: a two-minute signature over the
// publication id that the content server trades for a cookie on the link's
// own origin. The cookie lasts an hour, so losing access to the document
// closes the link within the hour.

export const MEMBER_COOKIE = "pub_member";
export const MEMBER_TTL_SECONDS = 60 * 60;
const GRANT_TTL_SECONDS = 120;

function signed(kind: "grant" | "member", publicationId: string, expires: number) {
    return crypto
        .createHmac("sha256", derivedKey("cookie"))
        .update(`${kind}\0${publicationId}\0${expires}`)
        .digest("base64url");
}

function signedValue(kind: "grant" | "member", publicationId: string, ttl: number, now: number) {
    const expires = Math.floor(now / 1000) + ttl;
    return `${expires}.${signed(kind, publicationId, expires)}`;
}

function signedValid(kind: "grant" | "member", publicationId: string, value: string | undefined, now: number) {
    if (!value) return false;
    const [expiresRaw, mac] = value.split(".");
    const expires = Number(expiresRaw);
    if (!Number.isInteger(expires) || !mac || expires * 1000 <= now) return false;
    const expected = Buffer.from(signed(kind, publicationId, expires));
    const actual = Buffer.from(mac);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export const signInGrant = (publicationId: string, now = Date.now()) =>
    signedValue("grant", publicationId, GRANT_TTL_SECONDS, now);
export const signInGrantValid = (publicationId: string, value: string | undefined, now = Date.now()) =>
    signedValid("grant", publicationId, value, now);
export const memberCookieValue = (publicationId: string, now = Date.now()) =>
    signedValue("member", publicationId, MEMBER_TTL_SECONDS, now);
export const memberCookieValid = (publicationId: string, value: string | undefined, now = Date.now()) =>
    signedValid("member", publicationId, value, now);

/** Where a signed-in-only link sends its visitor to sign in. */
export function signInUrl(publicationId: string, path: string, env: NodeJS.ProcessEnv = process.env): string {
    const app = (env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
    const query = new URLSearchParams({ p: publicationId });
    if (path) query.set("r", path);
    return `${app}/published?${query.toString()}`;
}

/** A path inside a publication that is safe to redirect to: relative, no climbing. */
export function safeInnerPath(raw: unknown): string {
    if (typeof raw !== "string") return "";
    const path = raw.replace(/^\/+/, "");
    if (path.length > 1024 || /[\\\u0000-\u001f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return "";
    if (path.split("/").some((segment) => segment === "..")) return "";
    return path;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    webm: "video/webm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
};

export function contentTypeForPath(path: string): string {
    const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Sites that published pages may frame: video and audio players.
const FRAME_SOURCES = [
    "https://www.youtube-nocookie.com",
    "https://www.youtube.com",
    "https://player.vimeo.com",
    "https://open.spotify.com",
    "https://w.soundcloud.com",
];

/**
 * A published page runs as an ordinary page on its own origin; the content
 * origin is what isolates it from the app. It may load media, styles, fonts
 * and scripts over https and frame the players above. It cannot submit forms
 * (no phishing pages), embed plugins, or be framed itself.
 */
export const SITE_CSP = [
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    "connect-src 'self' https:",
    `frame-src ${FRAME_SOURCES.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join("; ");

/** The service's own pages (password, not found): no script at all. */
export const PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
