// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SEAL_INFO, sealSecret, type SealedValue } from "./seal";

const subtle = globalThis.crypto.subtle;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const raw = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

async function vaultKey() {
    const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
    ])) as CryptoKeyPair;
    const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    return { pair, pub, key: { kid: "0123456789abcdef", public_key: b64(pub) } };
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
    return new TextDecoder().decode(plain);
}

describe("sealSecret", () => {
    it("seals a value only the vault's private key opens, bound to the key id", async () => {
        const { pair, pub, key } = await vaultKey();
        const sealed = await sealSecret(key, "a value with ünïcode and / + =");
        expect(sealed.kid).toBe(key.kid);
        expect(JSON.stringify(sealed)).not.toContain("ünïcode");
        expect(sealed.epk).not.toMatch(/[+/=]/);
        await expect(open(pair, pub, sealed, `${SEAL_INFO}|${key.kid}`)).resolves.toBe(
            "a value with ünïcode and / + =",
        );
        await expect(open(pair, pub, sealed, `${SEAL_INFO}|other`)).rejects.toThrow();
    });

    it("uses a fresh ephemeral key and nonce for every value", async () => {
        const { key } = await vaultKey();
        const [a, b] = await Promise.all([sealSecret(key, "same"), sealSecret(key, "same")]);
        expect(a.epk).not.toBe(b.epk);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
    });
});
