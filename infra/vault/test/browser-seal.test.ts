// The web app seals a value in the browser (frontend/src/app/lib/vault/seal.ts)
// and only this service can open it. The two implementations must agree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { sealSecret } from "../../../frontend/src/app/lib/vault/seal.ts";
import { generateSealingKey, unsealPayload } from "../src/crypto.ts";

const input = {
  value: "ghp_example-token-value-ünïcode",
  user: "user-a",
  name: "api",
  hosts: ["api.example.com"],
  injection: { type: "bearer" },
  writes: "ask" as const,
};

describe("browser sealing", () => {
  it("produces envelopes the vault opens, with their settings, and only for the key it named", async () => {
    const { key } = await generateSealingKey();
    const sealed = await sealSecret({ kid: key.kid, public_key: key.publicKey, epoch: "epoch-1" }, input);
    const payload = await unsealPayload(key, sealed);
    assert.deepEqual({ ...payload, nonce: undefined, iat: undefined }, { ...input, epoch: "epoch-1", nonce: undefined, iat: undefined });
    assert.ok(payload.nonce.length >= 16);
    assert.ok(Math.abs(payload.iat - Date.now()) < 5000);
    const other = (await generateSealingKey()).key;
    await assert.rejects(unsealPayload(other, { ...sealed, kid: other.kid }));
  });

  it("refuses a key that does not match its id or the pinned fingerprint", async () => {
    const { key } = await generateSealingKey();
    const fingerprint = createHash("sha256").update(key.publicRaw).digest("hex");
    await sealSecret({ kid: key.kid, public_key: key.publicKey, epoch: "e" }, input, { pinnedKeySha256: fingerprint.toUpperCase() });
    const other = (await generateSealingKey()).key;
    // A substituted key, presented under the real key's id or its own.
    await assert.rejects(sealSecret({ kid: key.kid, public_key: other.publicKey, epoch: "e" }, input), /could not be verified/);
    await assert.rejects(
      sealSecret({ kid: other.kid, public_key: other.publicKey, epoch: "e" }, input, { pinnedKeySha256: fingerprint }),
      /could not be verified/,
    );
  });
});
