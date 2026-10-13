/**
 * Seals a secret to the vault's public key before it leaves the page, so the
 * backend relays ciphertext it cannot open (the vault holds the private key,
 * infra/vault/src/crypto.ts). ECDH P-256 with a fresh key per value,
 * HKDF-SHA256, then AES-256-GCM; the associated data names the vault key.
 */
export const SEAL_INFO = "mike-vault/seal/v1";

export type SealedValue = { kid: string; epk: string; iv: string; ct: string };

function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

const encode = (text: string) => new TextEncoder().encode(text);

export async function sealSecret(
    vaultKey: { kid: string; public_key: string },
    value: string,
    subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<SealedValue> {
    const vaultRaw = fromBase64url(vaultKey.public_key);
    const vaultPublic = await subtle.importKey(
        "raw",
        vaultRaw,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
    );
    const ephemeral = (await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
    )) as CryptoKeyPair;
    const epkRaw = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
    const shared = await subtle.deriveBits(
        { name: "ECDH", public: vaultPublic },
        ephemeral.privateKey,
        256,
    );
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(epkRaw.length + vaultRaw.length);
    salt.set(epkRaw);
    salt.set(vaultRaw, epkRaw.length);
    const aes = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: encode(SEAL_INFO) },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
    );
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encode(`${SEAL_INFO}|${vaultKey.kid}`) },
        aes,
        encode(value),
    );
    return {
        kid: vaultKey.kid,
        epk: base64url(epkRaw),
        iv: base64url(iv),
        ct: base64url(new Uint8Array(ct)),
    };
}
