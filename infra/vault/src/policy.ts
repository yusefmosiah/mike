// What a secret may be used for, and how it is attached to a request.
// Nothing here knows about any particular service.

export type Injection =
  /** `Authorization: Bearer <secret>` */
  | { type: "bearer" }
  /** `Authorization: Basic base64(<username>:<secret>)`, which git over HTTPS uses. */
  | { type: "basic"; username: string }
  /** `<name>: <secret>`, for APIs that take a key in their own header. */
  | { type: "header"; name: string };

/** Whether a lease may make requests that change things (anything but GET, HEAD, OPTIONS). */
export type WritePolicy = "ask" | "allow";

export type Access = "read" | "write";

export const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the vault sets or that change how the request travels; never a custom secret header. */
const RESERVED_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade",
  "keep-alive", "proxy-authorization", "proxy-connection", "cookie",
]);
export const MAX_HOSTS = 10;

/**
 * Headers a secret may be put in: named for a credential. Servers log and
 * store other headers (User-Agent, Referer, object metadata) where whoever
 * makes the request can read them back, which would carry the secret past
 * the scrubber.
 */
const CREDENTIAL_WORD = /token|key|auth|secret|passw|session/i;
const STORED_HEADER_PREFIX = /^x-(amz|goog|ms|object|container|account|oss|cos|bz)-meta-|^x-(amz|goog)-/i;
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_WORD.test(name) && !STORED_HEADER_PREFIX.test(name);
}

export class PolicyError extends Error {}

/**
 * A destination a secret may be sent to: one DNS name, always HTTPS on port
 * 443. IP addresses are refused: a name is what the certificate is checked
 * against. So are wildcards: `*.github.io` or `*.s3.amazonaws.com` would let
 * anyone who can make a subdomain receive the secret, and telling those apart
 * from a company's own domain needs the public suffix list. Hosts are few and
 * fixed, so each is named.
 */
export function normalizeHost(input: unknown): string {
  if (typeof input !== "string") throw new PolicyError("host must be a string");
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.includes("*")) throw new PolicyError("wildcards are not allowed; name each host");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new PolicyError(`not a host name: ${JSON.stringify(input)}`);
  }
  if (/^\d+$/.test(labels.at(-1)!)) throw new PolicyError("IP addresses are not allowed; use a host name");
  return host;
}

export function normalizeHosts(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new PolicyError("at least one host is required");
  if (input.length > MAX_HOSTS) throw new PolicyError(`at most ${MAX_HOSTS} hosts`);
  return [...new Set(input.map(normalizeHost))];
}

export function hostAllowed(hosts: string[], host: string): boolean {
  const target = host.toLowerCase();
  return hosts.some((allowed) => target === allowed);
}

export function normalizeInjection(input: unknown): Injection {
  const value = (input ?? {}) as Record<string, unknown>;
  switch (value.type) {
    case "bearer":
      return { type: "bearer" };
    case "basic": {
      const username = typeof value.username === "string" ? value.username : "";
      if (!username || username.length > 128 || /[:\r\n]/.test(username)) {
        throw new PolicyError("basic auth needs a username without ':' or line breaks");
      }
      return { type: "basic", username };
    }
    case "header": {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
        throw new PolicyError("header injection needs a valid, unreserved header name");
      }
      if (!isCredentialHeader(name)) {
        throw new PolicyError("a secret goes only in a header named for a credential (with token, key, auth, secret, password or session in its name)");
      }
      return { type: "header", name };
    }
    default:
      throw new PolicyError("injection type must be bearer, basic or header");
  }
}

export function normalizeWrites(input: unknown): WritePolicy {
  return input === "allow" ? "allow" : "ask";
}

export function normalizeName(input: unknown): string {
  const name = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new PolicyError("name must be 1-63 characters: lowercase letters, digits, '.', '_' or '-'");
  }
  return name;
}

export function normalizeDescription(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new PolicyError("description must be text");
  return input.trim().slice(0, 300);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Read or write by HTTP method. This is a convention, not a guarantee: an API
 * that changes things on GET is not stopped by a read lease (docs/vault.md).
 * One POST only reads: git's smart-HTTP fetch, which every clone and pull
 * sends to `<repo>/git-upload-pack` (a push goes to `git-receive-pack`).
 */
export function accessFor(method: string, path = "", query = ""): Access {
  const upper = method.toUpperCase();
  if (READ_METHODS.has(upper)) return "read";
  if (upper === "POST" && query === "" && path.split("/").at(-1) === "git-upload-pack") return "read";
  return "write";
}

/** Headers that make a GET act as another method on some servers; never forwarded. */
export const METHOD_OVERRIDE_HEADERS = new Set(["x-http-method-override", "x-http-method", "x-method-override"]);
/** Query parameters that do the same; a read lease refuses a request carrying one. */
export const METHOD_OVERRIDE_PARAMS = new Set(["_method", "x-http-method-override", "x-http-method", "x-method-override"]);

/** The header that carries the secret. */
export function injectedHeader(injection: Injection, secret: string): [string, string] {
  switch (injection.type) {
    case "bearer":
      return ["authorization", `Bearer ${secret}`];
    case "basic":
      return ["authorization", `Basic ${Buffer.from(`${injection.username}:${secret}`).toString("base64")}`];
    case "header":
      return [injection.name.toLowerCase(), secret];
  }
}

/**
 * The forms of `bytes` that survive inside a longer base64 text: the encoding
 * at each of the three alignments, without the characters its neighbours
 * change. Standard and URL-safe alphabets.
 */
function base64Forms(bytes: Buffer): string[] {
  const out: string[] = [bytes.toString("base64"), bytes.toString("base64url")];
  for (let offset = 0; offset < 3; offset++) {
    const text = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64").replace(/=+$/, "");
    // The first group mixes in the preceding bytes, the last the following.
    const start = offset === 0 ? 0 : 4;
    const partial = (bytes.length + offset) % 3;
    const end = text.length - (partial === 0 ? 0 : partial + 1);
    const middle = text.slice(start, Math.max(start, end));
    out.push(middle, middle.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

/** Every form of the secret that could come back in a response, longest first. */
export function scrubPatterns(injection: Injection, secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const encoded = encodeURIComponent(secret);
  const forms = new Set([
    secret,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    encodeURIComponent(encoded),
    // JSON string escaping, including the optional escaped slash.
    JSON.stringify(secret).slice(1, -1),
    secret.replace(/\//g, "\\/"),
    JSON.stringify(secret).slice(1, -1).replace(/\//g, "\\/"),
    // ASCII-only JSON (\uXXXX for everything else).
    JSON.stringify(secret).slice(1, -1).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    ...base64Forms(bytes),
  ]);
  if (injection.type === "basic") {
    for (const form of base64Forms(Buffer.from(`${injection.username}:${secret}`))) forms.add(form);
  }
  // Very short forms would match ordinary text; values that short are refused at entry.
  return [...forms].filter((form) => form.length >= 8).sort((a, b) => b.length - a.length);
}

const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
/**
 * HTML5 named character references for the ASCII characters that have them,
 * without the semicolon (matched optionally). Names are matched without
 * regard to case. Letters and digits have none; non-ASCII characters are
 * matched in their numeric forms only.
 */
const HTML_NAMED: Record<string, string[]> = {
  "\t": ["&Tab"], "!": ["&excl"], '"': ["&quot", "&QUOT"], "#": ["&num"], "$": ["&dollar"],
  "%": ["&percnt"], "&": ["&amp", "&AMP"], "'": ["&apos"], "(": ["&lpar"], ")": ["&rpar"],
  "*": ["&ast", "&midast"], "+": ["&plus"], ",": ["&comma"], ".": ["&period"], "/": ["&sol"],
  ":": ["&colon"], ";": ["&semi"], "<": ["&lt", "&LT"], "=": ["&equals"], ">": ["&gt", "&GT"],
  "?": ["&quest"], "@": ["&commat"], "[": ["&lsqb", "&lbrack"], "\\": ["&bsol"],
  "]": ["&rsqb", "&rbrack"], "^": ["&Hat"], "_": ["&lowbar", "&UnderBar"],
  "`": ["&grave", "&DiacriticalGrave"], "{": ["&lcub", "&lbrace"],
  "|": ["&verbar", "&vert", "&VerticalLine"], "}": ["&rcub", "&rbrace"],
};

/**
 * Each way one character of the secret can appear in a body or header read
 * as latin1 (one character per byte): its UTF-8 bytes, percent-encoded once
 * or twice, JSON-escaped (\uXXXX or a backslash), or as an HTML entity.
 * Matched case-insensitively, so escapes in either case are found.
 */
function characterForms(ch: string): { source: string; longest: number } {
  const bytes = [...Buffer.from(ch, "utf8")];
  const units = [...Array(ch.length).keys()].map((i) => ch.charCodeAt(i));
  const code = ch.codePointAt(0)!;
  const forms = new Set<string>([
    escapeRegExp(Buffer.from(ch, "utf8").toString("latin1")),
    bytes.map((b) => `%${hex2(b)}`).join(""),
    bytes.map((b) => `%25${hex2(b)}`).join(""),
    units.map((u) => `\\\\u${u.toString(16).padStart(4, "0")}`).join(""),
    // Numeric references, semicolon optional, with any number of leading
    // zeros (a stream counts each as one character, scrub.ts).
    `&#0*${code};?`,
    `&#x0*${code.toString(16)};?`,
    ...(HTML_NAMED[ch] ?? []).map((name) => `${escapeRegExp(name)};?`),
  ]);
  if (ch === "/" || ch === '"' || ch === "\\") forms.add(`\\\\${escapeRegExp(ch)}`);
  if (ch === " ") forms.add("\\+");
  // Longest text one form can match, a numeric reference counted as at
  // most 11 (scrub.ts measures held-back text that way).
  const longest = Math.max(bytes.length * 5, units.length * 6, 11, ...(HTML_NAMED[ch] ?? []).map((n) => n.length + 1));
  return { source: `(?:${[...forms].join("|")})`, longest };
}

/** What removes a secret from responses: literal forms, and one expression for the escaped ones. */
export type ScrubSpec = {
  /** Literal forms, as latin1 text (one character per byte). */
  patterns: string[];
  /** Every character in any of its escaped forms, and base64 runs with their edges. */
  expression: RegExp;
  /** The longest text either can match: what a stream must hold back. */
  window: number;
};

export function scrubSpec(injection: Injection, secret: string): ScrubSpec {
  const patterns = scrubPatterns(injection, secret).map((p) => Buffer.from(p, "utf8").toString("latin1"));
  const chars = [...secret].map(characterForms);
  const charwise = chars.map((c) => c.source).join("");
  // A secret inside a longer base64 text: the stable middle at each
  // alignment, with the groups on either side that mix in its bytes.
  const sources = [Buffer.from(secret, "utf8")];
  if (injection.type === "basic") sources.push(Buffer.from(`${injection.username}:${secret}`, "utf8"));
  const base64 = sources
    .flatMap((bytes) => base64Forms(bytes).slice(2))
    .filter((form) => form.length >= 8)
    .map((form) => `[A-Za-z0-9+/_-]{0,4}${escapeRegExp(form)}[A-Za-z0-9+/_=-]{0,4}`);
  const window = Math.max(
    chars.reduce((total, c) => total + c.longest, 0),
    ...patterns.map((p) => p.length),
    ...base64.map((b) => b.length),
  );
  return { patterns, expression: new RegExp([charwise, ...base64].join("|"), "gi"), window };
}

/**
 * No part of a value leaves the vault, not even the last characters people
 * use to tell keys apart: names and descriptions do that.
 */
export function hintFor(_secret: string): string {
  return "";
}

export const MIN_SECRET_LENGTH = 8;
/** Long enough for any token or key; short enough that scrubbing stays cheap. */
export const MAX_SECRET_LENGTH = 4096;
