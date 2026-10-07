import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEgressAllowed, EgressSecurityError } from "./egress";

// Deterministic targets only: IP literals resolve without any DNS query (the
// lookup returns the literal) and "localhost" comes from the hosts file, so
// these tests run offline and cannot flake on resolver state. ".invalid" is
// reserved (RFC 6761) and never resolves.
const PUBLIC_IP = "93.184.216.34";

describe("assertEgressAllowed", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Explicitly off, so a STRICT_PRIVATE_MODE from the ambient environment
    // cannot change what "today's behavior" means in the non-strict cases.
    vi.stubEnv("STRICT_PRIVATE_MODE", "");
    vi.stubEnv("PRIVATE_MODE_ALLOWED_EGRESS_HOSTS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes any well-formed URL through outside strict private mode, with no policy applied", async () => {
    const url = await assertEgressAllowed(
      `https://${PUBLIC_IP}/v1/chat/completions`,
      "llm",
    );
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe(PUBLIC_IP);

    // Search purpose is a pass-through too: the search gate (and its DNS
    // resolution) is only consulted when strict mode is on.
    const searchUrl = await assertEgressAllowed(
      "https://api.keenable.ai/v1/search",
      "search",
    );
    expect(searchUrl.hostname).toBe("api.keenable.ai");
  });

  it("rejects a malformed URL, in both modes", async () => {
    await expect(assertEgressAllowed("not a url", "llm")).rejects.toThrow(
      EgressSecurityError,
    );

    vi.stubEnv("STRICT_PRIVATE_MODE", "true");
    await expect(assertEgressAllowed("not a url", "audio")).rejects.toThrow(
      EgressSecurityError,
    );
  });

  it("allows hosts on private and loopback networks in strict mode (DGX/LAN operators)", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    await expect(
      assertEgressAllowed("http://10.0.0.5:8080/v1", "llm"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertEgressAllowed("http://127.0.0.1:11434/v1", "llm"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertEgressAllowed("http://localhost:11434/v1", "audio"),
    ).resolves.toBeInstanceOf(URL);
    // IPv6 literals arrive bracketed from URL.hostname and must still resolve
    // as private (unique-local fd00::/8).
    await expect(
      assertEgressAllowed("http://[fd00::5]:8080/v1", "llm"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("fails loud for a public host in strict mode, naming the purpose", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    await expect(
      assertEgressAllowed(`https://${PUBLIC_IP}/v1`, "llm"),
    ).rejects.toThrow(EgressSecurityError);
    await expect(
      assertEgressAllowed(`https://${PUBLIC_IP}/v1`, "llm"),
    ).rejects.toThrow(/Egress blocked for llm/);
    await expect(
      assertEgressAllowed(`https://${PUBLIC_IP}/v1`, "audio"),
    ).rejects.toThrow(/Egress blocked for audio/);
  });

  it("allows an allowlisted host and its subdomains, but nothing else, in strict mode", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");
    vi.stubEnv("PRIVATE_MODE_ALLOWED_EGRESS_HOSTS", "operator.example.com");

    await expect(
      assertEgressAllowed("https://operator.example.com/v1", "llm"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertEgressAllowed("https://gpu-1.operator.example.com/v1", "llm"),
    ).resolves.toBeInstanceOf(URL);

    // A lookalike host is not a subdomain match; it still falls through to
    // the public-network refusal.
    await expect(
      assertEgressAllowed("https://notoperator.example.com/v1", "llm"),
    ).rejects.toThrow(EgressSecurityError);
  });

  it("fails loud when a host cannot be resolved at all in strict mode", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    await expect(
      assertEgressAllowed("https://does-not-exist.invalid/v1", "llm"),
    ).rejects.toThrow(EgressSecurityError);
  });

  it("delegates search-purpose checks to the search gate in strict mode", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    // The search gate's own strict-mode refusal, not this module's.
    await expect(
      assertEgressAllowed("https://api.keenable.ai/search", "search"),
    ).rejects.toThrow(/forbidden in strict private mode/);
  });
});
