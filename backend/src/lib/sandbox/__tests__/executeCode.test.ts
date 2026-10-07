import { describe, expect, it } from "vitest";

import { EXECUTE_CODE_MAX_CODE_CHARS, executeCode } from "../index";

describe("executeCode", () => {
  it("evaluates arithmetic, strings, dates and JSON", async () => {
    expect(await executeCode({ code: "(1 + 2) * 3" })).toEqual({
      ok: true,
      output: "9",
      truncated: false,
    });
    expect(await executeCode({ code: '"abc".toUpperCase()' })).toEqual({
      ok: true,
      output: "ABC",
      truncated: false,
    });
    expect(await executeCode({ code: "new Date(0).toISOString()" })).toEqual({
      ok: true,
      output: "1970-01-01T00:00:00.000Z",
      truncated: false,
    });
    expect(await executeCode({ code: "JSON.parse('{\"a\":[1,2]}')" })).toEqual({
      ok: true,
      output: '{"a":[1,2]}',
      truncated: false,
    });
  });

  it("captures console output before the completion value", async () => {
    const result = await executeCode({
      code: 'console.log("sum", 1 + 1); console.warn("warn"); console.error({ code: 7 }); "done"',
    });
    expect(result).toEqual({
      ok: true,
      output: 'sum 2\nwarn\n{"code":7}\ndone',
      truncated: false,
    });
  });

  it("omits the completion value when the script has none", async () => {
    expect(await executeCode({ code: "const x = 5;" })).toEqual({
      ok: true,
      output: "",
      truncated: false,
    });
  });

  it("reports syntax errors as a string error", async () => {
    const result = await executeCode({ code: "let x = ;" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a syntax error result");
    expect(result.error).toMatch(/unexpected/i);
  });

  it("reports thrown values as the error message", async () => {
    const error = await executeCode({ code: 'throw new Error("boom")' });
    expect(error.ok).toBe(false);
    if (error.ok) throw new Error("expected a thrown-error result");
    expect(error.error).toBe("boom");

    const object = await executeCode({ code: "throw { stage: 2 }" });
    expect(object.ok).toBe(false);
    if (object.ok) throw new Error("expected a thrown-error result");
    expect(object.error).toBe('{"stage":2}');
  });

  it("stops an infinite loop via the timeout", async () => {
    const result = await executeCode({
      code: "while (true) {}",
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a timeout result");
    expect(result.error).toMatch(/timed out/i);
  });

  it("truncates output at maxOutputChars and flags it", async () => {
    const result = await executeCode({
      code: '"x".repeat(500)',
      maxOutputChars: 100,
    });
    expect(result).toEqual({
      ok: true,
      output: "x".repeat(100),
      truncated: true,
    });
  });

  it("enforces the code-length limit", async () => {
    const tooLong = "1;".repeat(EXECUTE_CODE_MAX_CODE_CHARS / 2 + 1);
    const rejected = await executeCode({ code: tooLong });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected a length rejection");
    expect(rejected.error).toContain(String(EXECUTE_CODE_MAX_CODE_CHARS));

    const atLimit = "1;" + " ".repeat(EXECUTE_CODE_MAX_CODE_CHARS - 2);
    expect(atLimit.length).toBe(EXECUTE_CODE_MAX_CODE_CHARS);
    expect(await executeCode({ code: atLimit })).toEqual({
      ok: true,
      output: "1",
      truncated: false,
    });
  });

  it("rejects non-string code", async () => {
    const result = await executeCode({ code: 42 as unknown as string });
    expect(result).toEqual({ ok: false, error: "code must be a string." });
  });

  it("exposes no ambient or network globals", async () => {
    const names = [
      "process",
      "require",
      "module",
      "exports",
      "global",
      "fetch",
      "Buffer",
      "XMLHttpRequest",
      "WebSocket",
      "URL",
      "setTimeout",
      "setInterval",
      "queueMicrotask",
      "structuredClone",
    ];
    const probes = names.map((name) => `typeof ${name}`).join(", ");
    const result = await executeCode({
      code: `[${probes}].join(",")`,
    });
    expect(result).toEqual({
      ok: true,
      output: names.map(() => "undefined").join(","),
      truncated: false,
    });
  });

  it("is deterministic for identical code", async () => {
    const code =
      'const rows = [1, 2, 3].map((n) => n * n); console.log(rows.join(",")); rows.length;';
    const first = await executeCode({ code });
    const second = await executeCode({ code });
    expect(first).toEqual({
      ok: true,
      output: "1,4,9\n3",
      truncated: false,
    });
    expect(second).toEqual(first);
  });
});
