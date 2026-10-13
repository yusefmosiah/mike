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

export class PolicyError extends Error {}

/**
 * A destination a secret may be sent to: a DNS name, or `*.` and a name for
 * its subdomains (not the name itself). Always HTTPS on port 443. IP
 * addresses are refused: a name is what the certificate is checked against.
 */
export function normalizeHost(input: unknown): string {
  if (typeof input !== "string") throw new PolicyError("host must be a string");
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  const labels = name.split(".");
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
  return hosts.some((allowed) =>
    allowed.startsWith("*.") ? target.endsWith(allowed.slice(1)) && target.length > allowed.length - 1 : target === allowed,
  );
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
export function accessFor(method: string): Access {
  return READ_METHODS.has(method.toUpperCase()) ? "read" : "write";
}

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

/** Every form of the secret that could come back in a response, longest first. */
export function scrubPatterns(injection: Injection, secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]);
  if (injection.type === "basic") forms.add(Buffer.from(`${injection.username}:${secret}`).toString("base64"));
  // Very short values would match ordinary text; they are refused at entry.
  return [...forms].filter((form) => form.length >= 8).sort((a, b) => b.length - a.length);
}

/** The last characters people use to recognise a key, or nothing for short values. */
export function hintFor(secret: string): string {
  return secret.length >= 16 ? secret.slice(-4) : "";
}

export const MIN_SECRET_LENGTH = 8;
export const MAX_SECRET_LENGTH = 16_384;
