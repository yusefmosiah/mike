// Encryption at rest and the browser's sealed envelope.
//
// At rest (envelope encryption):
//   master key  32 random bytes in the state directory, readable by this
//               service only. It never leaves this process.
//   user key    32 random bytes per user, stored wrapped by the master key
//               with AES-256-GCM; the user id is the associated data.
//   secret      AES-256-GCM under the user key; the associated data binds
//               the ciphertext to its user and secret id, so a value copied
//               into another row or another user's record does not decrypt.
//
// In transit from the browser (sealed values): ECDH P-256 between an
// ephemeral browser key and this service's sealing key, HKDF-SHA256, then
// AES-256-GCM. The backend relays the envelope and cannot open it. What is
// sealed is the value together with everything that decides where it may
// go (owner, name, hosts, how it is attached, the write policy), a nonce and
// the time, so whoever relays the envelope cannot store it for someone else,
// send it to another host, or store it twice.
import { createCipheriv, createDecipheriv, createHash, randomBytes, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
/** WebCrypto wants bytes backed by a plain ArrayBuffer; a Buffer may share a pool. */
const u8 = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export type Box = { iv: string; ct: string; tag: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");
export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function randomKey(): Buffer {
  return randomBytes(32);
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Box {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
}

export function open(key: Buffer, box: Box, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(box.iv));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(unb64(box.tag));
  return Buffer.concat([decipher.update(unb64(box.ct)), decipher.final()]);
}

export const userKeyAad = (userId: string) => `mike-vault/user-key/v1|${userId}`;
export const secretAad = (userId: string, secretId: string) => `mike-vault/secret/v1|${userId}|${secretId}`;

// ---------------------------------------------------------------------------
// Sealed values from the browser

export const SEAL_INFO = "mike-vault/seal/v2";

/** What the browser seals: the value and the settings it was entered with. */
export type SealedPayload = {
  value: string;
  user: string;
  name: string;
  description?: string;
  hosts: string[];
  injection: unknown;
  writes: string;
  /** Random, once per envelope. */
  nonce: string;
  /** The vault process the key was fetched from (/v1/seal-key). */
  epoch: string;
  /** A stored secret (its id) this one takes the place of, with the user's new value. */
  replaces?: string;
  /** When it was sealed, in milliseconds since the epoch. */
  iat: number;
};

/** What a browser sends: its ephemeral public key and the ciphertext. */
export type SealedValue = {
  /** Identifies the sealing key the browser used. */
  kid: string;
  /** Ephemeral P-256 public key, uncompressed point, base64url. */
  epk: string;
  /** AES-GCM nonce, base64url. */
  iv: string;
  /** Ciphertext with the 16-byte tag appended (WebCrypto's layout), base64url. */
  ct: string;
};

export type SealingKey = {
  kid: string;
  /** Uncompressed public point, base64url. */
  publicKey: string;
  privateKey: webcrypto.CryptoKey;
  publicRaw: Buffer;
};

export function kidFor(publicRaw: Uint8Array): string {
  return createHash("sha256").update(publicRaw).digest("hex").slice(0, 16);
}

export async function generateSealingKey(): Promise<{ key: SealingKey; pkcs8: Buffer }> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pkcs8 = Buffer.from(await subtle.exportKey("pkcs8", pair.privateKey));
  return { key: await importSealingKey(pkcs8), pkcs8 };
}

export async function importSealingKey(pkcs8: Buffer): Promise<SealingKey> {
  const privateKey = await subtle.importKey("pkcs8", u8(pkcs8), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  // The public point is part of the private key's JWK.
  const jwk = await subtle.exportKey("jwk", privateKey);
  const publicKey = await subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const publicRaw = Buffer.from(await subtle.exportKey("raw", publicKey));
  return { kid: kidFor(publicRaw), publicKey: b64url(publicRaw), privateKey, publicRaw };
}

async function sealKey(shared: ArrayBuffer, epkRaw: Uint8Array, vaultRaw: Uint8Array): Promise<webcrypto.CryptoKey> {
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: u8(Buffer.concat([epkRaw, vaultRaw])), info: u8(Buffer.from(SEAL_INFO)) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Opens what the browser sealed to `key`. Throws on any mismatch. */
export async function unsealValue(key: SealingKey, sealed: SealedValue): Promise<Buffer> {
  if (sealed.kid !== key.kid) throw new Error("sealed with an unknown key");
  const epkRaw = Buffer.from(sealed.epk, "base64url");
  const epk = await subtle.importKey("raw", u8(epkRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, key.privateKey, 256);
  const aes = await sealKey(shared, epkRaw, key.publicRaw);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: u8(Buffer.from(sealed.iv, "base64url")), additionalData: u8(Buffer.from(`${SEAL_INFO}|${key.kid}`)) },
    aes,
    u8(Buffer.from(sealed.ct, "base64url")),
  );
  return Buffer.from(plain);
}

/** Opens a sealed payload and checks its shape; the caller checks what it says. */
export async function unsealPayload(key: SealingKey, sealed: SealedValue): Promise<SealedPayload> {
  const parsed = JSON.parse((await unsealValue(key, sealed)).toString("utf8")) as Record<string, unknown>;
  const text = (field: string) => typeof parsed[field] === "string";
  if (
    !parsed || typeof parsed !== "object" || !text("value") || !text("user") || !text("name") || !text("writes") ||
    !text("nonce") || !text("epoch") || !Array.isArray(parsed.hosts) || typeof parsed.iat !== "number" ||
    (parsed.description !== undefined && !text("description")) ||
    (parsed.replaces !== undefined && !text("replaces"))
  ) {
    throw new Error("malformed sealed payload");
  }
  return parsed as unknown as SealedPayload;
}

/**
 * The browser's half, for tests and tools: the web app's
 * frontend/src/app/lib/vault/seal.ts does exactly this with WebCrypto.
 */
export async function sealValue(publicKey: string, kid: string, payload: SealedPayload): Promise<SealedValue> {
  const vaultRaw = Buffer.from(publicKey, "base64url");
  const vaultKey = await subtle.importKey("raw", u8(vaultRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const epkRaw = Buffer.from(await subtle.exportKey("raw", eph.publicKey));
  const shared = await subtle.deriveBits({ name: "ECDH", public: vaultKey }, eph.privateKey, 256);
  const aes = await sealKey(shared, epkRaw, vaultRaw);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: u8(iv), additionalData: u8(Buffer.from(`${SEAL_INFO}|${kid}`)) },
    aes,
    u8(Buffer.from(JSON.stringify(payload), "utf8")),
  );
  return { kid, epk: b64url(epkRaw), iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}
