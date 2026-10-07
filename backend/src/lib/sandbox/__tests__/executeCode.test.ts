import { describe, expect, it } from "vitest";
import { EXECUTE_CODE_DISABLED_ERROR, executeCode } from "../executeCode";

describe("executeCode (disabled)", () => {
  it("never runs code, including the host-intrinsics escape that the vm version allowed", async () => {
    const escape = `Object.constructor("return process")().env`;
    await expect(executeCode({ code: escape })).resolves.toEqual({
      ok: false,
      error: EXECUTE_CODE_DISABLED_ERROR,
    });
  });

  it("refuses plain computation too", async () => {
    await expect(executeCode({ code: "1 + 1" })).resolves.toEqual({
      ok: false,
      error: EXECUTE_CODE_DISABLED_ERROR,
    });
  });
});
