import { describe, expect, it, vi } from "vitest";

import { runScript } from "../runScript";

const tools = (impl: Record<string, (args: any) => unknown>) => ({
  toolNames: Object.keys(impl),
  callTool: vi.fn(async (name: string, args: unknown) => JSON.stringify(await impl[name](args))),
});

describe("runScript", () => {
  it("returns logs and the script's value", async () => {
    const result = await runScript({ code: "console.log('hi', {a: 1}); return 6 * 7;", toolNames: [], callTool: vi.fn() });
    expect(result).toMatchObject({ ok: true, result: 42, toolCalls: 0 });
    if (result.ok) expect(result.output).toBe('hi {\n  "a": 1\n}');
  });

  it("calls tools and gets parsed results", async () => {
    const t = tools({ add: ({ a, b }) => ({ sum: a + b }) });
    const result = await runScript({ code: "const r = await tools.add({a: 2, b: 3}); return r.sum;", ...t });
    expect(result).toMatchObject({ ok: true, result: 5, toolCalls: 1 });
    expect(t.callTool).toHaveBeenCalledWith("add", { a: 2, b: 3 });
  });

  it("runs tool calls concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const t = tools({
      slow: async ({ n }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return n * 2;
      },
    });
    const result = await runScript({ code: "return await Promise.all([1,2,3,4].map((n) => tools.slow({n})));", ...t });
    expect(result).toMatchObject({ ok: true, result: [2, 4, 6, 8], toolCalls: 4 });
    expect(peak).toBe(4);
  });

  it("only exposes allowed tools", async () => {
    const t = tools({ read: () => 1 });
    const result = await runScript({ code: "return [typeof tools.read, typeof tools.delete_everything, Object.keys(tools)];", ...t });
    expect(result).toMatchObject({ ok: true, result: ["function", "undefined", ["read"]] });
  });

  it("has no host APIs", async () => {
    const result = await runScript({
      code: "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.__proto__.constructor.constructor('return this')().process];",
      toolNames: [],
      callTool: vi.fn(),
    });
    expect(result).toMatchObject({ ok: true, result: ["undefined", "undefined", "undefined", "undefined", "undefined"] });
  });

  it("reports thrown errors and tool failures", async () => {
    expect(await runScript({ code: "throw new TypeError('bad input');", toolNames: [], callTool: vi.fn() })).toMatchObject({ ok: false, error: "TypeError: bad input" });
    const failing = { toolNames: ["boom"], callTool: vi.fn(async () => { throw new Error("upstream down"); }) };
    expect(await runScript({ code: "await tools.boom({}); return 1;", ...failing })).toMatchObject({ ok: false, error: "upstream down" });
    const caught = await runScript({ code: "try { await tools.boom({}); } catch (e) { return 'caught: ' + e.message; }", ...failing });
    expect(caught).toMatchObject({ ok: true, result: "caught: upstream down" });
  });

  it("stops an infinite loop at the deadline", async () => {
    const result = await runScript({ code: "while (true) {}", toolNames: [], callTool: vi.fn(), timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: "Script timed out after 1 s" });
  });

  it("stops a script waiting on a slow tool at the deadline", async () => {
    const t = { toolNames: ["hang"], callTool: vi.fn(() => new Promise<string>(() => {})) };
    const result = await runScript({ code: "await tools.hang({}); return 1;", ...t, timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: "Script timed out after 1 s" });
  });

  it("caps tool calls", async () => {
    const t = tools({ ping: () => "pong" });
    const result = await runScript({ code: "for (let i = 0; i < 5; i++) await tools.ping({}); return 'done';", ...t, maxToolCalls: 3 });
    expect(result).toMatchObject({ ok: false, error: "Too many tool calls: the limit is 3 per script", toolCalls: 4 });
  });

  it("caps memory", async () => {
    const result = await runScript({ code: "const a = new Uint8Array(32 * 1024 * 1024); return a.length;", toolNames: [], callTool: vi.fn(), memoryLimitBytes: 16 * 1024 * 1024 });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/out of memory/) });
  });

  it("truncates long output", async () => {
    const result = await runScript({ code: "for (let i = 0; i < 1000; i++) console.log('line ' + i);", toolNames: [], callTool: vi.fn(), maxOutputChars: 1000 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.output.endsWith("[... output truncated ...]")).toBe(true);
  });

  it("reports syntax errors", async () => {
    const result = await runScript({ code: "return (;", toolNames: [], callTool: vi.fn() });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/SyntaxError|expecting/i);
  });
});

describe("runScript cancellation", () => {
  it("stops when the turn is aborted", async () => {
    const controller = new AbortController();
    const t = { toolNames: ["hang"], callTool: vi.fn(() => new Promise<string>(() => {})) };
    setTimeout(() => controller.abort(), 50);
    const result = await runScript({ code: "await tools.hang({}); return 1;", ...t, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "Script cancelled" });
  });
});
