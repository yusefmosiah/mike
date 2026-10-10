// Intel TDX quote verification (DCAP, quote version 4, ECDSA P-256), written
// from Intel's "TDX DCAP Quoting Library API" quote layout.
//
// What this proves, from the quote alone:
//  - the TD report body (measurements and report_data) is signed by the
//    quote's attestation key;
//  - that key is the one Intel's TD Quoting Enclave vouched for (the QE
//    report binds sha256(attestation key || QE auth data));
//  - the QE report is signed by the platform's PCK certificate, which chains
//    to Intel's SGX Root CA (pinned below by fingerprint);
//  - the QE is Intel's TD QE (MRSIGNER and product id as Intel publishes in
//    its TDX QE identity), and the TD is not in debug mode.
// What it does not prove: that the platform's TCB is up to date. That needs
// Intel's signed TCB info and revocation lists for the platform (collateral),
// which this verifier does not fetch yet; see goals/STATUS.md.

import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";

/** SHA-256 of Intel SGX Root CA's certificate (certificates.trustedservices.intel.com). */
export const INTEL_SGX_ROOT_CA_SHA256 =
  "44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3";
/** Intel's TD Quoting Enclave identity (PCS tdx/certification/v4/qe/identity). */
const TD_QE_MRSIGNER = "dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5";
const TD_QE_ISVPRODID = 2;
const TD_QE_ATTRIBUTES = { value: "11000000000000000000000000000000", mask: "fbffffffffffffff0000000000000000" };
const INTEL_QE_VENDOR_ID = "939a7233f79c4ca9940a0db3957f0607";

const HEADER = 48;
const BODY = 584;
const QE_REPORT = 384;

export type TdxQuote = {
  mrTd: string;
  rtmrs: [string, string, string, string];
  reportData: Buffer;
  tdAttributes: Buffer;
};

export type TdxVerification = ({ ok: true } & TdxQuote) | { ok: false; reason: string };

class QuoteError extends Error {}

function reader(bytes: Buffer) {
  let offset = 0;
  const take = (length: number) => {
    if (offset + length > bytes.length) throw new QuoteError("quote is truncated");
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  return {
    take,
    u16: () => take(2).readUInt16LE(0),
    u32: () => take(4).readUInt32LE(0),
    get offset() {
      return offset;
    },
  };
}

function p256Key(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(0, 32).toString("base64url"), y: raw.subarray(32, 64).toString("base64url") },
    format: "jwk",
  });
}

const p1363 = (data: Buffer, key: KeyObject, signature: Buffer) =>
  verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);

function certificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

function checkChain(chain: X509Certificate[], now: Date): void {
  if (chain.length < 3) throw new QuoteError("PCK certificate chain is incomplete");
  const [leaf, intermediate, root] = chain;
  if (root.fingerprint256 !== INTEL_SGX_ROOT_CA_SHA256) throw new QuoteError("PCK chain does not end at Intel's root CA");
  if (!root.verify(root.publicKey)) throw new QuoteError("Intel root CA signature is invalid");
  if (!intermediate.verify(root.publicKey) || !intermediate.checkIssued(root)) throw new QuoteError("PCK CA is not issued by Intel's root CA");
  if (!leaf.verify(intermediate.publicKey) || !leaf.checkIssued(intermediate)) throw new QuoteError("PCK certificate is not issued by the PCK CA");
  for (const cert of chain) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) throw new QuoteError("a PCK chain certificate is not valid now");
  }
}

function maskedEquals(value: Buffer, expected: string, mask: string): boolean {
  const want = Buffer.from(expected, "hex");
  const bits = Buffer.from(mask, "hex");
  return want.every((byte, index) => ((value[index] ?? 0) & bits[index]) === (byte & bits[index]));
}

/** Verify a hex-encoded TDX v4 quote; never throws. */
export function verifyTdxQuote(quoteHex: string, now = new Date()): TdxVerification {
  try {
    if (!/^[0-9a-f]+$/i.test(quoteHex)) throw new QuoteError("quote is not hex");
    const bytes = Buffer.from(quoteHex, "hex");
    const read = reader(bytes);
    const header = read.take(HEADER);
    if (header.readUInt16LE(0) !== 4) throw new QuoteError("unsupported quote version");
    if (header.readUInt16LE(2) !== 2) throw new QuoteError("unsupported attestation key type");
    if (header.readUInt32LE(4) !== 0x81) throw new QuoteError("quote is not a TDX quote");
    if (header.subarray(12, 28).toString("hex") !== INTEL_QE_VENDOR_ID) throw new QuoteError("quote is not from Intel's quoting enclave");
    const body = read.take(BODY);
    const signed = bytes.subarray(0, HEADER + BODY);

    read.u32(); // signature data length
    const signature = read.take(64);
    const attestationKey = read.take(64);
    if (read.u16() !== 6) throw new QuoteError("unexpected certification data type");
    read.u32();
    const qeReport = read.take(QE_REPORT);
    const qeSignature = read.take(64);
    const authData = read.take(read.u16());
    if (read.u16() !== 5) throw new QuoteError("quote carries no PCK certificate chain");
    const pem = read.take(read.u32()).toString("utf8");

    if (!p1363(signed, p256Key(attestationKey), signature)) throw new QuoteError("quote signature is invalid");

    const chain = certificates(pem);
    checkChain(chain, now);
    if (!p1363(qeReport, chain[0].publicKey, qeSignature)) throw new QuoteError("QE report signature is invalid");

    // SGX report body: attributes at 48, MRSIGNER at 128, ISVPRODID at 256, report data at 320.
    const binding = createHash("sha256").update(attestationKey).update(authData).digest();
    const qeData = qeReport.subarray(320, 384);
    if (!qeData.subarray(0, 32).equals(binding) || qeData.subarray(32).some((byte) => byte !== 0)) {
      throw new QuoteError("QE report does not bind the attestation key");
    }
    if (qeReport.subarray(128, 160).toString("hex") !== TD_QE_MRSIGNER) throw new QuoteError("QE is not Intel's TD quoting enclave");
    if (qeReport.readUInt16LE(256) !== TD_QE_ISVPRODID) throw new QuoteError("QE product id is not the TD QE");
    if (!maskedEquals(qeReport.subarray(48, 64), TD_QE_ATTRIBUTES.value, TD_QE_ATTRIBUTES.mask)) {
      throw new QuoteError("QE attributes do not match Intel's TD QE identity");
    }

    // TD report body: TDATTRIBUTES at 120, MRTD at 136, RTMR0-3 at 328, REPORTDATA at 520.
    const tdAttributes = body.subarray(120, 128);
    if (tdAttributes[0] & 1) throw new QuoteError("TD is in debug mode");
    const rtmr = (index: number) => body.subarray(328 + 48 * index, 376 + 48 * index).toString("hex");
    return {
      ok: true,
      mrTd: body.subarray(136, 184).toString("hex"),
      rtmrs: [rtmr(0), rtmr(1), rtmr(2), rtmr(3)],
      reportData: Buffer.from(body.subarray(520, 584)),
      tdAttributes: Buffer.from(tdAttributes),
    };
  } catch (error) {
    if (error instanceof QuoteError) return { ok: false, reason: error.message };
    return { ok: false, reason: "quote could not be parsed" };
  }
}
