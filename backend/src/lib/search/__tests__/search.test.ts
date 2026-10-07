import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  assertSafeEgressUrl,
  EgressSecurityError,
  getProviderAdapter,
  KeenableAdapter,
  TavilyAdapter,
  ExaAdapter,
  ParallelAdapter,
  fetchPage,
  getWebSnapshot,
  clearWebSnapshots,
  search,
} from "../index";

describe("assertSafeEgressUrl (SSRF & Private Mode)", () => {
  it("rejects loopback and private IP addresses", async () => {
    await expect(assertSafeEgressUrl("http://127.0.0.1/admin")).rejects.toThrow(
      EgressSecurityError,
    );
    await expect(assertSafeEgressUrl("http://localhost:8080")).rejects.toThrow(
      EgressSecurityError,
    );
  });

  it("rejects non-http protocols", async () => {
    await expect(assertSafeEgressUrl("file:///etc/passwd")).rejects.toThrow(
      "Forbidden URL scheme 'file:'",
    );
    await expect(assertSafeEgressUrl("ftp://ftp.example.com")).rejects.toThrow(
      "Forbidden URL scheme 'ftp:'",
    );
  });

  it("blocks external hosts when STRICT_PRIVATE_MODE is enabled without allowlist", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");
    vi.stubEnv("PRIVATE_MODE_ALLOWED_EGRESS_HOSTS", "internal-gateway.firm.com");

    await expect(assertSafeEgressUrl("https://api.keenable.ai/search")).rejects.toThrow(
      "forbidden in strict private mode",
    );
  });
});

describe("Search Provider Adapters", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the requested provider adapter", () => {
    expect(getProviderAdapter("keenable")).toBeInstanceOf(KeenableAdapter);
    expect(getProviderAdapter("tavily")).toBeInstanceOf(TavilyAdapter);
    expect(getProviderAdapter("exa")).toBeInstanceOf(ExaAdapter);
    expect(getProviderAdapter("parallel")).toBeInstanceOf(ParallelAdapter);
  });

  it("KeenableAdapter executes POST to Keenable search API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "SEC Filing",
            url: "https://sec.gov/filing",
            snippet: "Corporate disclosure summary",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new KeenableAdapter();
    const results = await adapter.search("SEC Form 10-K", {
      apiKey: "test-keenable-key",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "SEC Filing",
      url: "https://sec.gov/filing",
      snippet: "Corporate disclosure summary",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.keenable.ai/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-API-Key": "test-keenable-key" }),
      }),
    );
  });
});

describe("fetchPage & Web Snapshot Store", () => {
  beforeEach(() => {
    clearWebSnapshots();
    vi.unstubAllEnvs();
  });

  it("fetches page, strips HTML, hashes content and saves to snapshot store", async () => {
    const html = `
      <html>
        <head><title>Test Report</title><style>.hidden { display: none; }</style></head>
        <body>
          <h1>Delaware Chancery Opinion</h1>
          <p>Under DGCL Section 141, the board of directors manages corporate affairs.</p>
        </body>
      </html>
    `;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    vi.stubGlobal("fetch", fetchMock);

    // Mock assertSafeEgressUrl implicitly passing safe URL
    const page = await fetchPage("https://courts.delaware.gov/opinions/123");

    expect(page.content).toContain("Delaware Chancery Opinion");
    expect(page.content).toContain("Under DGCL Section 141");
    expect(page.content).not.toContain("<style>");
    expect(page.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    const retrieved = getWebSnapshot("https://courts.delaware.gov/opinions/123");
    expect(retrieved).toBeDefined();
    expect(retrieved?.contentSha256).toBe(page.contentSha256);
  });
});
