import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { jcs, PHALA_GATEWAY_REPO, reportDataFor, requireVerifiedUpstream, verifyAciReceipt, verifyAciReport } from "../aci";
import { verifyTdxQuote } from "../tdx";
import { getConfiguredModel, resetModelRegistryCache } from "../../registry";

// A real report from Phala's gateway (inference.phala.com) and one real
// chat completion's signed receipt, captured 2026-10-10. Everything in it is
// public attestation data; the exchange is a one-word test prompt.
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "phala-aci.json"), "utf8"));
const capturedAt = new Date(fixture.captured_at);
const policy = { repoUrl: PHALA_GATEWAY_REPO };
const options = { nonce: fixture.nonce, host: "inference.phala.com", observedSpki: fixture.observed_spki, policy, now: capturedAt };
const clone = () => JSON.parse(JSON.stringify(fixture.report));

/** Flip one hex digit at `index` of a hex string. */
const flip = (hex: string, index: number) => hex.slice(0, index) + (hex[index] === "0" ? "1" : "0") + hex.slice(index + 1);

describe("TDX quote", () => {
  it("verifies Phala's quote to Intel's root", () => {
    const result = verifyTdxQuote(fixture.report.attestation.evidence.quote, capturedAt);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reportData.subarray(0, 32).toString("hex")).toBe(fixture.report.attestation.report_data);
  });

  it("rejects a quote whose measurements were edited", () => {
    // Byte 48 + 136 starts MRTD in the signed TD report body.
    const result = verifyTdxQuote(flip(fixture.report.attestation.evidence.quote, 2 * (48 + 136)), capturedAt);
    expect(result).toEqual({ ok: false, reason: "quote signature is invalid" });
  });

  it("rejects truncated or non-hex quotes and certificates outside their validity", () => {
    expect(verifyTdxQuote(fixture.report.attestation.evidence.quote.slice(0, 2000), capturedAt).ok).toBe(false);
    expect(verifyTdxQuote("zz", capturedAt)).toEqual({ ok: false, reason: "quote is not hex" });
    expect(verifyTdxQuote(fixture.report.attestation.evidence.quote, new Date("2099-01-01"))).toEqual({
      ok: false,
      reason: "a PCK chain certificate is not valid now",
    });
  });
});

describe("ACI report", () => {
  it("establishes the gateway's identity", () => {
    const result = verifyAciReport(fixture.report, options);
    expect(result).toMatchObject({
      ok: true,
      keysetDigest: fixture.report.workload_keyset_digest,
      tlsSpkis: [fixture.observed_spki],
      composeHash: "0637b3d506c80c0328c84697c290f5fb7eef811c8d022124e04ee9b0f5f99567",
      repoCommit: "8d0a666a2418898a8c823a9af49a634edd122a64",
    });
  });

  it("computes the spec's canonical forms", () => {
    expect(jcs({ b: [1, { d: "x", c: null }], a: "é" })).toBe('{"a":"é","b":[1,{"c":null,"d":"x"}]}');
    expect(reportDataFor(fixture.report.workload_keyset_digest, fixture.nonce)).toBe(fixture.report.attestation.report_data);
  });

  it("fails closed on each broken link", () => {
    const cases: [string, (report: Record<string, any>) => void, object?][] = [
      ["report does not bind our nonce", () => {}, { nonce: "0".repeat(64) }],
      ["keyset digest does not match the keyset", (r) => r.attestation.workload_keyset.tls_public_keys.push({ spki_sha256: "f".repeat(64) })],
      ["keyset has expired", () => {}, { now: new Date((fixture.report.attestation.workload_keyset.not_after + 1) * 1000) }],
      ["app compose is not the measured one", (r) => (r.attestation.evidence.app_compose += " ")],
      ["event log does not replay to RTMR3", (r) => {
        const log = JSON.parse(r.attestation.evidence.event_log);
        log.pop();
        r.attestation.evidence.event_log = JSON.stringify(log);
      }],
      ["workload is not built from the expected repository", () => {}, { policy: { repoUrl: "https://github.com/someone/else" } }],
      ["measured compose is not the pinned one", () => {}, { policy: { ...policy, composeHash: "a".repeat(64) } }],
      ["the server's TLS key is not the attested one", () => {}, { observedSpki: "b".repeat(64) }],
      ["keyset lists no TLS key for elsewhere.example", () => {}, { host: "elsewhere.example" }],
      ["quote signature is invalid", (r) => (r.attestation.evidence.quote = flip(r.attestation.evidence.quote, 2 * (48 + 520)))],
      ["not an aci/1 attestation report", (r) => (r.api_version = "aci/2")],
    ];
    for (const [reason, edit, overrides] of cases) {
      const report = clone();
      edit(report);
      expect(verifyAciReport(report, { ...options, ...overrides }), reason).toEqual({ ok: false, reason });
    }
  });
});

describe("ACI receipts", () => {
  const identity = (() => {
    const result = verifyAciReport(fixture.report, options);
    if (!result.ok) throw new Error(result.reason);
    return result;
  })();
  const sent = Buffer.from(fixture.exchange.sent);
  const received = Buffer.from(fixture.exchange.received, "base64");

  it("asks the gateway for verified upstreams only", () => {
    expect(JSON.parse(requireVerifiedUpstream('{"model":"m","provider":{"order":["x"]}}'))).toEqual({
      model: "m",
      provider: { order: ["x"], aci_verified: true },
    });
    expect(JSON.parse(fixture.exchange.sent).provider).toEqual({ aci_verified: true });
  });

  it("verifies a real receipt against the bytes exchanged", () => {
    expect(verifyAciReceipt(fixture.exchange.receipt, identity, sent, received)).toMatchObject({ ok: true, receiptId: fixture.exchange.receipt.receipt_id });
  });

  it("rejects a receipt for other bytes, another key or a forged field", () => {
    expect(verifyAciReceipt(fixture.exchange.receipt, identity, Buffer.from(`${sent} `), received)).toEqual({ ok: false, reason: "receipt does not match the request sent" });
    expect(verifyAciReceipt(fixture.exchange.receipt, identity, sent, Buffer.concat([received, Buffer.from("x")]))).toEqual({ ok: false, reason: "receipt does not match the response received" });
    expect(verifyAciReceipt({ ...fixture.exchange.receipt, model: "other" }, identity, sent, received)).toEqual({ ok: false, reason: "receipt signature is invalid" });
    expect(verifyAciReceipt(fixture.exchange.receipt, { ...identity, receiptKeys: new Map() }, sent, received)).toEqual({ ok: false, reason: "receipt is signed by an unknown key" });
  });
});

describe("ACI model configuration", () => {
  const original = process.env.MIKE_MODEL_CONFIG_JSON;
  afterEach(() => {
    if (original === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = original;
    resetModelRegistryCache();
  });
  const configure = (attestation: unknown, baseUrl = "https://inference.phala.com/v1") => {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
      models: [{ id: "phala/glm", provider: "openai-compatible", location: "cloud", baseUrl, apiModel: "z-ai/glm-5.3", attestation }],
    });
    resetModelRegistryCache();
    return getConfiguredModel("phala/glm");
  };

  it("defaults the repository to Phala's gateway and keeps a compose pin", () => {
    expect(configure({ scheme: "aci" })?.attestation).toEqual({ scheme: "aci", repoUrl: PHALA_GATEWAY_REPO });
    expect(configure({ scheme: "aci", composeHash: "A".repeat(64) })?.attestation).toEqual({
      scheme: "aci",
      repoUrl: PHALA_GATEWAY_REPO,
      composeHash: "a".repeat(64),
    });
  });

  it("drops the whole model on a malformed declaration or plain HTTP", () => {
    expect(configure({ scheme: "acii" })).toBeNull();
    expect(configure({ scheme: "aci", composeHash: "short" })).toBeNull();
    expect(configure({ scheme: "aci" }, "http://inference.phala.com/v1")).toBeNull();
  });
});
