/**
 * Seals a secret to the vault's public key before it leaves the page, so the
 * backend relays ciphertext it cannot open (the vault holds the private key,
 * infra/vault/src/crypto.ts). ECDH P-256 with a fresh key per value,
 * HKDF-SHA256, then AES-256-GCM; the associated data names the vault key.
 *
 * What is sealed is the value together with the settings it is entered with
 * (owner, name, hosts, how it is attached, the write policy), a nonce, the
 * time and the vault process's epoch: the vault uses only those, so whoever relays the envelope cannot
 * store it for someone else, send it to another host, or store it twice.
 *
 * The key itself comes from the backend. The build pins the key's SHA-256
 * (NEXT_PUBLIC_VAULT_SEAL_KEY_SHA256), so a backend that hands out another
 * key is refused here; a production build without a pin seals nothing.
 */
export const SEAL_INFO = "mike-vault/seal/v2";

export type SealedValue = { kid: string; epk: string; iv: string; ct: string };

export type SealInput = {
    value: string;
    /** The account the secret is for: the signed-in user. */
    user: string;
    name: string;
    description?: string;
    hosts: string[];
    injection: unknown;
    writes: "ask" | "allow";
};

/** The backend offered a key other than the vault's: nothing was sealed. */
export class VaultKeyMismatchError extends Error {
    constructor() {
        super("The vault's key could not be verified. Nothing was sent.");
        this.name = "VaultKeyMismatchError";
    }
}

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

const hex = (bytes: ArrayBuffer) =>
    [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const encode = (text: string) => new TextEncoder().encode(text);

export async function sealSecret(
    /** From the vault's seal-key: the key, its id, and the vault process's epoch. */
    vaultKey: { kid: string; public_key: string; epoch: string },
    input: SealInput,
    options: {
        /** The key's expected SHA-256, hex; null or empty checks only the key id. */
        pinnedKeySha256?: string | null;
        /** Refuse to seal without a pin (production builds). */
        requirePin?: boolean;
        subtle?: SubtleCrypto;
        now?: () => number;
    } = {},
): Promise<SealedValue> {
    const subtle = options.subtle ?? globalThis.crypto.subtle;
    const vaultRaw = fromBase64url(vaultKey.public_key);
    const digest = hex(await subtle.digest("SHA-256", vaultRaw));
    const pinned = options.pinnedKeySha256?.trim().toLowerCase();
    if (options.requirePin && !/^[0-9a-f]{64}$/.test(pinned ?? "")) throw new VaultKeyMismatchError();
    if (digest.slice(0, 16) !== vaultKey.kid || (pinned && digest !== pinned)) {
        throw new VaultKeyMismatchError();
    }
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
    const payload = {
        ...input,
        epoch: vaultKey.epoch,
        nonce: base64url(globalThis.crypto.getRandomValues(new Uint8Array(16))),
        iat: (options.now ?? Date.now)(),
    };
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encode(`${SEAL_INFO}|${vaultKey.kid}`) },
        aes,
        encode(JSON.stringify(payload)),
    );
    return {
        kid: vaultKey.kid,
        epk: base64url(epkRaw),
        iv: base64url(iv),
        ct: base64url(new Uint8Array(ct)),
    };
}
