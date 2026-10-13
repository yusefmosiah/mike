// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SEAL_INFO, sealSecret, VaultKeyMismatchError, type SealedValue } from "./seal";

const subtle = globalThis.crypto.subtle;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const raw = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const INPUT = {
    value: "a value with ünïcode and / + =",
    user: "user-1",
    name: "deploy",
    hosts: ["api.example.com"],
    injection: { type: "bearer" },
    writes: "ask" as const,
};

async function vaultKey() {
    const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
    ])) as CryptoKeyPair;
    const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    return { pair, pub, key: { kid: sha256(pub).slice(0, 16), public_key: b64(pub), epoch: "epoch-1" } };
}

/** What the vault does (infra/vault/src/crypto.ts), with the given AAD. */
async function open(pair: CryptoKeyPair, pub: Uint8Array, sealed: SealedValue, aad: string) {
    const epk = raw(sealed.epk);
    const ephemeral = await subtle.importKey("raw", epk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await subtle.deriveBits({ name: "ECDH", public: ephemeral }, pair.privateKey, 256);
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array([...epk, ...pub]);
    const aes = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(SEAL_INFO) },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
    );
    const plain = await subtle.decrypt(
        { name: "AES-GCM", iv: raw(sealed.iv), additionalData: new TextEncoder().encode(aad) },
        aes,
        raw(sealed.ct),
    );
    return JSON.parse(new TextDecoder().decode(plain));
}

describe("sealSecret", () => {
    it("seals the value with its settings, a nonce and the time, for the vault's key only", async () => {
        const { pair, pub, key } = await vaultKey();
        const sealed = await sealSecret(key, INPUT, { now: () => 1234 });
        expect(sealed.kid).toBe(key.kid);
        expect(JSON.stringify(sealed)).not.toContain("ünïcode");
        expect(sealed.epk).not.toMatch(/[+/=]/);
        const payload = await open(pair, pub, sealed, `${SEAL_INFO}|${key.kid}`);
        expect(payload).toEqual({ ...INPUT, epoch: "epoch-1", nonce: expect.any(String), iat: 1234 });
        expect(payload.nonce.length).toBeGreaterThanOrEqual(16);
        await expect(open(pair, pub, sealed, `${SEAL_INFO}|other`)).rejects.toThrow();
    });

    it("uses a fresh ephemeral key, nonce and envelope nonce for every value", async () => {
        const { pair, pub, key } = await vaultKey();
        const [a, b] = await Promise.all([sealSecret(key, INPUT), sealSecret(key, INPUT)]);
        expect(a.epk).not.toBe(b.epk);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
        const aad = `${SEAL_INFO}|${key.kid}`;
        expect((await open(pair, pub, a, aad)).nonce).not.toBe((await open(pair, pub, b, aad)).nonce);
    });

    it("refuses a key that does not match its id or the pinned fingerprint", async () => {
        const { pub, key } = await vaultKey();
        const other = await vaultKey();
        await expect(sealSecret(key, INPUT, { pinnedKeySha256: sha256(pub).toUpperCase() })).resolves.toBeTruthy();
        await expect(sealSecret(key, INPUT, { pinnedKeySha256: "" })).resolves.toBeTruthy();
        // A production build seals nothing without a well-formed pin.
        await expect(sealSecret(key, INPUT, { pinnedKeySha256: "", requirePin: true })).rejects.toBeInstanceOf(VaultKeyMismatchError);
        await expect(sealSecret(key, INPUT, { pinnedKeySha256: "abc", requirePin: true })).rejects.toBeInstanceOf(VaultKeyMismatchError);
        await expect(sealSecret(key, INPUT, { pinnedKeySha256: sha256(pub), requirePin: true })).resolves.toBeTruthy();
        await expect(
            sealSecret({ ...key, public_key: other.key.public_key }, INPUT),
        ).rejects.toBeInstanceOf(VaultKeyMismatchError);
        await expect(
            sealSecret(other.key, INPUT, { pinnedKeySha256: sha256(pub) }),
        ).rejects.toBeInstanceOf(VaultKeyMismatchError);
    });
});
