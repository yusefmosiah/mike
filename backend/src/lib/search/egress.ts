import dns from "node:dns/promises";
import { isBlockedIp } from "../privateIp";

export class EgressSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressSecurityError";
  }
}

/**
 * Validates that a target URL is safe to contact:
 * 1. Must use http: or https:
 * 2. Hostname must not resolve to a loopback, private, or reserved IP (SSRF protection).
 * 3. In strict private mode, external egress is blocked unless explicitly allowlisted.
 *
 * This remains the single search policy: lib/egress.ts delegates its
 * "search"-purpose checks here, and mirrors the allowlist semantics for the
 * LLM/audio purposes it gates itself.
 */
export async function assertSafeEgressUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EgressSecurityError(`Malformed URL: '${rawUrl}'`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EgressSecurityError(
      `Forbidden URL scheme '${parsed.protocol}'. Only http: and https: are permitted.`,
    );
  }

  const host = parsed.hostname;

  // Strict private mode check
  if (process.env.STRICT_PRIVATE_MODE === "true") {
    const allowedHosts = (process.env.PRIVATE_MODE_ALLOWED_EGRESS_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    const hostLower = host.toLowerCase();
    const isExplicitlyAllowed = allowedHosts.some(
      (allowed) => hostLower === allowed || hostLower.endsWith(`.${allowed}`),
    );

    if (!isExplicitlyAllowed) {
      throw new EgressSecurityError(
        `Egress blocked: external web access to '${host}' is forbidden in strict private mode.`,
      );
    }
  }

  // SSRF DNS resolution check
  try {
    const lookupResult = await dns.lookup(host, { all: true });
    for (const addr of lookupResult) {
      if (isBlockedIp(addr.address)) {
        throw new EgressSecurityError(
          `SSRF blocked: host '${host}' resolves to forbidden private or reserved IP '${addr.address}'.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof EgressSecurityError) throw err;
    throw new EgressSecurityError(
      `Failed to resolve host '${host}' for egress verification: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parsed;
}
