// The web app seals a value in the browser (frontend/src/app/lib/vault/seal.ts)
// and only this service can open it. The two implementations must agree.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sealSecret } from "../../../frontend/src/app/lib/vault/seal.ts";
import { generateSealingKey, unsealValue } from "../src/crypto.ts";

describe("browser sealing", () => {
  it("produces envelopes the vault opens, and only for the key it named", async () => {
    const { key } = await generateSealingKey();
    const value = "ghp_example-token-value-ünïcode";
    const sealed = await sealSecret({ kid: key.kid, public_key: key.publicKey }, value);
    assert.equal((await unsealValue(key, sealed)).toString("utf8"), value);
    const other = (await generateSealingKey()).key;
    await assert.rejects(unsealValue(other, { ...sealed, kid: other.kid }));
  });
});
