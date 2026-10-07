// Shared egress gate for outbound network requests: one place decides whether
// a URL may be contacted at all.
//
// Normal operation is a parse-only pass-through, so today's behavior is
// unchanged. Under STRICT_PRIVATE_MODE the deployment promises that data never
// leaves the segmented network, so each purpose gets the policy that fits it:
//
// - "search" keeps the search gate's own allowlist + SSRF rules, delegated
//   below so both paths share one policy instead of two drifting ones;
// - "llm"/"audio" may reach private/loopback networks (DGX/LAN operators are
//   the point of strict mode) or hosts explicitly listed in
//   PRIVATE_MODE_ALLOWED_EGRESS_HOSTS (exact host or subdomain, the same
//   semantics as the search gate).
//
// Failures throw EgressSecurityError and MUST stay loud: no fallback, no
// retry, no silently skipped request.
//
// Callers: lib/llm/aiSdk.ts gates every model request before its fetch, and
// modules/audio/audio.service.ts gates the STT/TTS operator requests.

import dns from "node:dns/promises";
import { isBlockedIp } from "./privateIp";
import { EgressSecurityError, assertSafeEgressUrl } from "./search/egress";
import { isStrictPrivateMode } from "./privateMode";

export { EgressSecurityError };

export type EgressPurpose = "llm" | "audio" | "search";

/**
 * Exact host or subdomain match, the same semantics as lib/search/egress.ts
 * (trim, lowercase, empty entries dropped) so one allowlist env var governs
 * every purpose.
 */
function isAllowlistedHost(host: string): boolean {
  const allowedHosts = (process.env.PRIVATE_MODE_ALLOWED_EGRESS_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const hostLower = host.toLowerCase();
  return allowedHosts.some(
    (allowed) => hostLower === allowed || hostLower.endsWith(`.${allowed}`),
  );
}

/**
 * Validate that an outbound request to `url` is permitted for `purpose`, and
 * return the parsed URL for the caller to fetch.
 *
 * Throws EgressSecurityError on a malformed URL and on any strict-mode
 * violation; callers let that propagate — a blocked request must fail loud,
 * never fall back to another endpoint.
 */
export async function assertEgressAllowed(
  url: string,
  purpose: EgressPurpose,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressSecurityError(
      `Malformed URL for ${purpose} egress check: '${url}'`,
    );
  }

  if (!isStrictPrivateMode()) return parsed;

  // Search keeps its own gate (allowlist + SSRF blocklist).
  if (purpose === "search") return assertSafeEgressUrl(url);

  const host = parsed.hostname;

  // An explicit allowlist entry is the operator's opt-in, so it passes
  // without resolving: a DNS failure must not veto a named host.
  if (isAllowlistedHost(host)) return parsed;

  let addresses: { address: string }[];
  try {
    // URL.hostname keeps the brackets on IPv6 literals ("[::1]"), which
    // dns.lookup rejects; strip them so IPv6 DGX endpoints resolve too.
    const lookupHost =
      host.startsWith("[") && host.endsWith("]")
        ? host.slice(1, -1)
        : host;
    addresses = await dns.lookup(lookupHost, { all: true });
  } catch (err) {
    throw new EgressSecurityError(
      `Egress blocked for ${purpose}: could not resolve '${host}' in strict private mode (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }

  // A host that resolves exclusively to loopback/private/reserved addresses
  // never crosses the network boundary (DGX/LAN operators). A mixed answer
  // is fail-closed: if any address is public, the host could leave.
  const allPrivate =
    addresses.length > 0 && addresses.every((a) => isBlockedIp(a.address));
  if (!allPrivate) {
    throw new EgressSecurityError(
      `Egress blocked for ${purpose}: host '${host}' is not on a private network and is not in PRIVATE_MODE_ALLOWED_EGRESS_HOSTS.`,
    );
  }
  return parsed;
}
