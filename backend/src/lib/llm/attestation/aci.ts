// Attested Confidential Inference (ACI, `aci/1`): Phala's confidential AI
// gateway (inference.phala.com) and anything else that speaks it. Spec:
// github.com/Dstack-TEE/private-ai-gateway, spec/aci.md. This module is the
// relying party's verifier for the dstack `tdx` evidence profile.
//
// Before a prompt is sent (spec §9.1):
//  1. Hardware: the TDX quote verifies to Intel's root (./tdx.ts).
//  2. Binding and freshness: the keyset's JCS digest equals the reported
//     digest, and sha256 of the statement naming that digest and our fresh
//     nonce is the quote's report_data.
//  3. Expiry: now < the keyset's not_after, which is not implausibly far.
//  4. Provenance: the boot event log replays to the quote's RTMRs, its
//     measured compose-hash is sha256(app_compose), and the reported source
//     repository is the one the policy names (optionally a pinned compose
//     hash too).
//  5. Channel: the TLS key the server presented when we fetched the report
//     is listed for that hostname, and every inference request goes over a
//     connection pinned to the listed keys (aciFetch).
// On every request we also ask the gateway to serve only through upstreams
// it verified (`provider.aci_verified`, §5.3), so a prompt is refused rather
// than sent to an unverified model; after the response, its signed receipt
// is checked against the bytes sent and received (§9.3).
// Not checked yet: the platform's TCB level (./tdx.ts), the dstack KMS
// custody chain for the keys (§3.3), and deep audit of the upstream
// sessions (§9.2); goals/STATUS.md tracks them.

import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from "node:crypto";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { verifyTdxQuote } from "./tdx";

export const ACI_VERIFIER_VERSION = "mike-aci/1";
export const PHALA_GATEWAY_REPO = "https://github.com/Dstack-TEE/private-ai-gateway";
/** Re-establish identity with a fresh nonce this often, even within not_after. */
const REVERIFY_MS = 10 * 60 * 1000;
/** A keyset that claims to live longer than this is rejected (spec §3.1). */
const MAX_KEYSET_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const REPORT_TIMEOUT_MS = 15_000;

export type AciPolicy = {
  /** Source repository the attested workload must be built from. */
  repoUrl: string;
  /** Optional pin: the exact measured app compose (sha256 hex). */
  composeHash?: string;
};

export type AciIdentity = {
  host: string;
  keysetDigest: string;
  notAfter: number;
  tlsSpkis: string[];
  receiptKeys: Map<string, string>;
  composeHash: string;
  repoCommit: string | null;
  mrTd: string;
};

export type AciVerification = ({ ok: true } & AciIdentity) | { ok: false; reason: string };

class AciError extends Error {}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** RFC 8785 for ACI documents: compact JSON with sorted keys (integers, ASCII keys). */
export function jcs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The value the quote must carry for this keyset and nonce (spec §3.2). */
export function reportDataFor(keysetDigest: string, nonce: string): string {
  return sha256(`{"keyset_digest":"${keysetDigest}","nonce":"${nonce}","purpose":"aci.report_data.v1"}`);
}

const normalizeRepo = (url: string) => url.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

type LogEvent = { imr: number; event_type: number; digest: string; event: string; event_payload: string };

function checkEventLog(eventLog: string, rtmrs: string[], appCompose: string): string {
  let events: LogEvent[];
  try {
    events = JSON.parse(eventLog) as LogEvent[];
  } catch {
    throw new AciError("event log is not JSON");
  }
  if (!Array.isArray(events)) throw new AciError("event log is not a list");
  const replayed = [0, 1, 2, 3].map(() => Buffer.alloc(48));
  for (const event of events) {
    if (!Number.isInteger(event?.imr) || event.imr < 0 || event.imr > 3 || !/^[0-9a-f]{96}$/i.test(event.digest)) {
      throw new AciError("event log entry is malformed");
    }
    if (event.imr === 3) {
      // dstack runtime events: digest = sha384(type LE32 || ":" || name || ":" || payload).
      const type = Buffer.alloc(4);
      type.writeUInt32LE(event.event_type >>> 0);
      const digest = createHash("sha384")
        .update(Buffer.concat([type, Buffer.from(":"), Buffer.from(text(event.event)), Buffer.from(":"), Buffer.from(text(event.event_payload), "hex")]))
        .digest("hex");
      if (digest !== event.digest.toLowerCase()) throw new AciError("an RTMR3 event does not match its digest");
    }
    replayed[event.imr] = createHash("sha384").update(Buffer.concat([replayed[event.imr], Buffer.from(event.digest, "hex")])).digest();
  }
  replayed.forEach((value, index) => {
    if (value.toString("hex") !== rtmrs[index]) throw new AciError(`event log does not replay to RTMR${index}`);
  });
  const composeEvents = events.filter((event) => event.imr === 3 && event.event === "compose-hash");
  if (composeEvents.length !== 1) throw new AciError("event log has no single measured compose hash");
  const composeHash = sha256(appCompose);
  if (composeEvents[0].event_payload.toLowerCase() !== composeHash) throw new AciError("app compose is not the measured one");
  return composeHash;
}

/**
 * Check one attestation report. `observedSpki` is the sha256 of the TLS key
 * the server presented on the connection that delivered it. Never throws.
 */
export function verifyAciReport(
  report: unknown,
  options: { nonce: string; host: string; observedSpki: string | null; policy: AciPolicy; now?: Date },
): AciVerification {
  const now = options.now ?? new Date();
  try {
    if (!isRecord(report) || report.api_version !== "aci/1") throw new AciError("not an aci/1 attestation report");
    const attestation = report.attestation;
    if (!isRecord(attestation) || attestation.tee_type !== "tdx") throw new AciError("report is not TDX evidence");
    const keyset = attestation.workload_keyset;
    const evidence = attestation.evidence;
    if (!isRecord(keyset) || !isRecord(evidence)) throw new AciError("report is missing its keyset or evidence");

    // 2. Binding and freshness.
    const keysetDigest = `sha256:${sha256(jcs(keyset))}`;
    if (keysetDigest !== report.workload_keyset_digest) throw new AciError("keyset digest does not match the keyset");
    const reportData = reportDataFor(keysetDigest, options.nonce);
    if (attestation.report_data !== reportData) throw new AciError("report does not bind our nonce");

    // 1. Hardware.
    const quote = verifyTdxQuote(text(evidence.quote), now);
    if (!quote.ok) throw new AciError(quote.reason);
    if (!quote.reportData.equals(Buffer.concat([Buffer.from(reportData, "hex"), Buffer.alloc(32)]))) {
      throw new AciError("quote does not carry the report data");
    }

    // 3. Expiry.
    const notAfter = Number(keyset.not_after) * 1000;
    if (!Number.isFinite(notAfter) || notAfter <= now.getTime()) throw new AciError("keyset has expired");
    if (notAfter - now.getTime() > MAX_KEYSET_LIFETIME_MS) throw new AciError("keyset expiry is implausibly far away");

    // 4. Provenance, backed by the measured compose.
    const composeHash = checkEventLog(text(evidence.event_log), quote.rtmrs, text(evidence.app_compose));
    if (options.policy.composeHash && composeHash !== options.policy.composeHash.toLowerCase()) {
      throw new AciError("measured compose is not the pinned one");
    }
    const provenance = isRecord(attestation.source_provenance) ? attestation.source_provenance : {};
    if (normalizeRepo(text(provenance.repo_url)) !== normalizeRepo(options.policy.repoUrl)) {
      throw new AciError("workload is not built from the expected repository");
    }

    // 5. Channel.
    const tlsSpkis = (Array.isArray(keyset.tls_public_keys) ? keyset.tls_public_keys : [])
      .filter(isRecord)
      .filter((entry) => !entry.domain || entry.domain === options.host)
      .map((entry) => text(entry.spki_sha256).toLowerCase())
      .filter((value) => /^[0-9a-f]{64}$/.test(value));
    if (tlsSpkis.length === 0) throw new AciError(`keyset lists no TLS key for ${options.host}`);
    if (!options.observedSpki || !tlsSpkis.includes(options.observedSpki)) {
      throw new AciError("the server's TLS key is not the attested one");
    }

    const receiptKeys = new Map<string, string>();
    for (const entry of Array.isArray(keyset.receipt_signing_keys) ? keyset.receipt_signing_keys : []) {
      if (isRecord(entry) && entry.algo === "ed25519" && /^[0-9a-f]{64}$/i.test(text(entry.public_key))) {
        receiptKeys.set(text(entry.key_id), text(entry.public_key).toLowerCase());
      }
    }

    return {
      ok: true,
      host: options.host,
      keysetDigest,
      notAfter,
      tlsSpkis,
      receiptKeys,
      composeHash,
      repoCommit: text(provenance.repo_commit) || null,
      mrTd: quote.mrTd,
    };
  } catch (error) {
    if (error instanceof AciError) return { ok: false, reason: error.message };
    return { ok: false, reason: "attestation report could not be checked" };
  }
}

/** sha256 of the certificate's DER SubjectPublicKeyInfo (`pubkey` alone is the bare key). */
function spkiOf(cert: PeerCertificate): string | null {
  try {
    return sha256(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" }));
  } catch {
    return null;
  }
}

type Established = { identity: AciIdentity; at: number };
const established = new Map<string, Established>();
const pending = new Map<string, Promise<AciVerification>>();

const cacheKey = (origin: string, policy: AciPolicy) => `${origin}|${normalizeRepo(policy.repoUrl)}|${policy.composeHash ?? ""}`;

/** Test seam. */
export function resetAciCache(): void {
  established.clear();
  pending.clear();
}

async function fetchAndVerify(origin: string, apiKey: string | undefined, policy: AciPolicy): Promise<AciVerification> {
  const host = new URL(origin).hostname;
  const nonce = randomBytes(32).toString("hex");
  let observedSpki: string | null = null;
  // A connection of its own, so the TLS key we check is the one that
  // delivered this report.
  const agent = new Agent({
    connect: {
      checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
        observedSpki = spkiOf(cert);
        return checkServerIdentity(hostname, cert);
      },
    },
  });
  try {
    const response = await undiciFetch(`${origin}/v1/aci/attestation?nonce=${nonce}`, {
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      dispatcher: agent,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `attestation report returned HTTP ${response.status}` };
    const report = await response.json().catch(() => null);
    return verifyAciReport(report, { nonce, host, observedSpki, policy });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "attestation report timed out" : "attestation report could not be fetched" };
  } finally {
    void agent.close().catch(() => {});
  }
}

/**
 * The endpoint's verified identity: reused while fresh, re-established with
 * a new nonce every few minutes, at expiry, or when the gateway reports a
 * different keyset. Never throws.
 */
export async function establishAci(baseUrl: string, apiKey: string | undefined, policy: AciPolicy): Promise<AciVerification> {
  const origin = new URL(baseUrl).origin;
  const key = cacheKey(origin, policy);
  const current = established.get(key);
  const now = Date.now();
  if (current && now - current.at < REVERIFY_MS && now < current.identity.notAfter) return { ok: true, ...current.identity };
  let inFlight = pending.get(key);
  if (!inFlight) {
    inFlight = fetchAndVerify(origin, apiKey, policy).then((result) => {
      if (result.ok) {
        const { ok: _ok, ...identity } = result;
        established.set(key, { identity, at: Date.now() });
      } else {
        established.delete(key);
      }
      return result;
    });
    inFlight.finally(() => pending.delete(key)).catch(() => {});
    pending.set(key, inFlight);
  }
  return inFlight;
}

function forget(origin: string, policy: AciPolicy): void {
  established.delete(cacheKey(origin, policy));
}

/** Adds `provider.aci_verified: true` to a JSON request body (spec §5.3). */
export function requireVerifiedUpstream(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!isRecord(parsed)) return body;
    const provider = isRecord(parsed.provider) ? parsed.provider : {};
    return JSON.stringify({ ...parsed, provider: { ...provider, aci_verified: true } });
  } catch {
    return body;
  }
}

export type ReceiptCheck = { ok: true; receiptId: string; sessionId: string | null } | { ok: false; reason: string };

/** Check a receipt against the established identity and the exact bytes exchanged (spec §9.3). */
export function verifyAciReceipt(
  receipt: unknown,
  identity: Pick<AciIdentity, "keysetDigest" | "receiptKeys">,
  sent: Buffer,
  received: Buffer,
): ReceiptCheck {
  if (!isRecord(receipt) || receipt.api_version !== "aci/1") return { ok: false, reason: "not an aci/1 receipt" };
  if (receipt.workload_keyset_digest !== identity.keysetDigest) return { ok: false, reason: "receipt names another keyset" };
  const publicKey = identity.receiptKeys.get(text(receipt.key_id));
  if (!publicKey) return { ok: false, reason: "receipt is signed by an unknown key" };
  const { signature, ...document } = receipt;
  const signatureBytes = Buffer.from(text(signature), "hex");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "hex").toString("base64url") }, format: "jwk" });
  if (signatureBytes.length !== 64 || !verify(null, Buffer.from(jcs(document)), key, signatureBytes)) {
    return { ok: false, reason: "receipt signature is invalid" };
  }
  const events = (Array.isArray(receipt.event_log) ? receipt.event_log : []).filter(isRecord);
  const hashOf = (type: string) => events.find((event) => event.type === type)?.body_hash;
  if (hashOf("request.received") !== `sha256:${sha256(sent)}`) return { ok: false, reason: "receipt does not match the request sent" };
  if (hashOf("response.returned") !== `sha256:${sha256(received)}`) return { ok: false, reason: "receipt does not match the response received" };
  const upstream = events.find((event) => event.type === "upstream.verified");
  if (upstream && (upstream.result !== "verified" || upstream.required !== true)) {
    return { ok: false, reason: "the upstream model was not verified" };
  }
  return { ok: true, receiptId: text(receipt.receipt_id), sessionId: upstream ? text(upstream.session_id) || null : null };
}

/**
 * The fetch every inference request to an ACI endpoint goes through: TLS
 * pinned to the established keyset's keys for the host, verified upstreams
 * required, and the signed receipt checked once the response is read.
 */
export function aciFetch(
  baseUrl: string,
  policy: AciPolicy,
  onReceipt: (check: ReceiptCheck) => void = logReceipt,
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  const key = cacheKey(origin, policy);
  const agent = new Agent({
    connect: {
      checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
        const identity = established.get(key)?.identity;
        const spki = spkiOf(cert);
        if (!identity || identity.host !== hostname || !spki || !identity.tlsSpkis.includes(spki)) {
          return new Error("TLS key is not the attested one");
        }
        return checkServerIdentity(hostname, cert);
      },
    },
  });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).origin !== origin) throw new Error("attested endpoint request went to another host");
    const identity = established.get(key)?.identity;
    if (!identity) throw new Error("Attested inference unavailable: identity not established");
    const sentText = typeof init?.body === "string" ? requireVerifiedUpstream(init.body) : undefined;
    if (init?.body !== undefined && init.body !== null && sentText === undefined) {
      throw new Error("attested endpoint requests must have a text body");
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const response = (await undiciFetch(url, {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: Object.fromEntries(headers.entries()),
      body: sentText,
      signal: init?.signal ?? undefined,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

    const served = response.headers.get("x-aci-keyset-digest");
    if (served && served !== identity.keysetDigest) forget(origin, policy);
    const receiptId = response.headers.get("x-receipt-id");
    if (!sentText || !receiptId || !response.body) return response;

    // Hash the body exactly as it streams to the caller, then check the receipt.
    const chunks: Buffer[] = [];
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        chunks.push(Buffer.from(chunk));
        controller.enqueue(chunk);
      },
      flush() {
        void fetchReceipt(origin, receiptId, headers.get("authorization"), agent)
          .then((receipt) => onReceipt(verifyAciReceipt(receipt, identity, Buffer.from(sentText), Buffer.concat(chunks))))
          .catch(() => onReceipt({ ok: false, reason: "receipt could not be fetched" }));
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

async function fetchReceipt(origin: string, id: string, authorization: string | null, agent: Agent): Promise<unknown> {
  // A streamed receipt is finalized as the stream ends; give it a moment.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await undiciFetch(`${origin}/v1/aci/receipts/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      dispatcher: agent,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (response.ok) return response.json();
    if (response.status !== 404) throw new Error(`receipt returned HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("receipt not found");
}

function logReceipt(check: ReceiptCheck): void {
  if (check.ok) console.info("[attestation] ACI receipt verified", { receiptId: check.receiptId, sessionId: check.sessionId });
  else console.warn("[attestation] ACI receipt check failed", { reason: check.reason });
}
