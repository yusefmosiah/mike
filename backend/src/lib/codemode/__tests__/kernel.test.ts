import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { kernelBundle, kernelStartCommand } from "../kernel/bundle";
import { KernelManager, localKernelLauncher, type KernelLauncher } from "../kernel/manager";
import { LineSplitter, parseKernelEvent } from "../kernel/protocol";
import { KernelSession, type HostReply } from "../kernel/session";
import { cellResultContent, pythonToolDoc, pythonToolSpecs } from "../python";

// The kernel runs as a local python3 process here, as it does in development
// without a VM; in production the same process runs over ssh in the VM.

const hasDill = spawnSync("python3", ["-c", "import dill"]).status === 0;
const workDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-test-"));
const launcher = localKernelLauncher(workDir);
const sessions: KernelSession[] = [];

async function startSession(tools = [{ name: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } }]) {
  const session = await KernelSession.start(launcher.spawn);
  sessions.push(session);
  await session.configure(tools);
  return session;
}

const echo = async (data: Record<string, unknown>): Promise<HostReply> => ({
  ok: true,
  content: JSON.stringify({ echoed: (data.args as { text?: string }).text }),
});

afterAll(async () => {
  for (const session of sessions) session.kill();
});

describe("kernel protocol parsing", () => {
  it("splits lines across chunks and skips an over-long line", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(10);
    splitter.push(Buffer.from('{"a":'), (line) => lines.push(line));
    splitter.push(Buffer.from('1}\n0123456789ABC\n{"b":2}\n'), (line) => lines.push(line));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.oversized).toBe(1);
  });

  it("accepts only well-formed events", () => {
    expect(parseKernelEvent('{"event":"stdout","id":"c","text":"hi"}')).toEqual({ event: "stdout", id: "c", text: "hi" });
    expect(parseKernelEvent('{"event":"stdout","id":"c","text":5}')).toBeNull();
    expect(parseKernelEvent('{"event":"done","id":"c","status":"maybe"}')).toBeNull();
    expect(parseKernelEvent('{"event":"host_request","id":"r","cell":"c","data":[]}')).toBeNull();
    expect(parseKernelEvent("not json")).toBeNull();
    expect(parseKernelEvent('["event"]')).toBeNull();
  });
});

describe("kernel session", () => {
  it("runs cells, keeps state, and calls tools through the host", async () => {
    const session = await startSession();
    const first = await session.execute("x = 20\nprint('hello')", { timeoutMs: 10_000, onHostRequest: echo });
    expect(first).toMatchObject({ status: "ok", stdout: "hello\n", result: null, error: null });
    const second = await session.execute("r = await tools.echo(text='hi')\n(x * 2, r['echoed'])", {
      timeoutMs: 10_000,
      onHostRequest: echo,
    });
    expect(second).toMatchObject({ status: "ok", result: "(40, 'hi')", hostRequests: 1 });
  });

  it("takes a parameter named after a Python keyword with a trailing underscore", async () => {
    const session = await startSession([
      { name: "read", parameters: { type: "object", properties: { doc: { type: "string" }, from: { type: "string" } }, required: ["doc"] } },
    ]);
    const seen: unknown[] = [];
    const outcome = await session.execute("await tools.read('doc-1', from_='t8')\nprint(tools.read.signature())", {
      timeoutMs: 10_000,
      onHostRequest: async (data) => {
        seen.push(data.args);
        return { ok: true, content: "text" };
      },
    });
    expect(outcome).toMatchObject({ status: "ok", stdout: "read(doc: str, from_: str = ...)\n" });
    expect(seen).toEqual([{ doc: "doc-1", from: "t8" }]);
  });

  it("does not count time spent in tool calls against the cell's limit", async () => {
    const session = await startSession();
    const slowTool = async (): Promise<HostReply> => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { ok: true, content: '"done"' };
    };
    const outcome = await session.execute("await tools.echo(text='x')", { timeoutMs: 1_000, onHostRequest: slowTool });
    expect(outcome).toMatchObject({ status: "ok", result: "'done'", timedOut: false });
  });

  it("interrupts a cell at its time limit and stays usable", async () => {
    const session = await startSession();
    const outcome = await session.execute("import asyncio\nawait asyncio.sleep(30)", { timeoutMs: 1_000, onHostRequest: echo });
    expect(outcome).toMatchObject({ status: "error", timedOut: true, kernelLost: false });
    expect(outcome.error?.ename).toBe("KeyboardInterrupt");
    const after = await session.execute("1 + 1", { timeoutMs: 5_000, onHostRequest: echo });
    expect(after.result).toBe("2");
  });

  it("stops a cell when the turn is aborted", async () => {
    const session = await startSession();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const outcome = await session.execute("import time\ntime.sleep(30)", {
      timeoutMs: 60_000,
      onHostRequest: echo,
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ status: "error", aborted: true, kernelLost: false });
  });

  it("reports a lost kernel instead of hanging", async () => {
    const session = await startSession();
    const outcome = await session.execute("import os\nos._exit(1)", { timeoutMs: 10_000, onHostRequest: echo });
    expect(outcome).toMatchObject({ status: "error", kernelLost: true });
    expect(session.alive).toBe(false);
  });

  it("refuses tool calls from a task left running after its cell", async () => {
    const session = await startSession();
    const onHostRequest = vi.fn(echo);
    await session.execute(
      "import asyncio\nasync def later():\n    await asyncio.sleep(0.3)\n    global late\n    try:\n        await tools.echo(text='late')\n        late = 'ran'\n    except ToolError as e:\n        late = str(e)\nbg = asyncio.ensure_future(later())",
      { timeoutMs: 5_000, onHostRequest },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const outcome = await session.execute("late", { timeoutMs: 5_000, onHostRequest });
    expect(outcome.result).toBe("'echo: no cell is running'");
    expect(onHostRequest).not.toHaveBeenCalled();
  });

  it("caps output, keeping its start and end", async () => {
    const session = await startSession();
    const outcome = await session.execute("for i in range(5000):\n    print('line', i)", {
      timeoutMs: 10_000,
      onHostRequest: echo,
      maxOutputChars: 2_000,
    });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toMatch(/^line 0\n/);
    expect(outcome.stdout).toMatch(/line 4999\n$/);
    expect(cellResultContent(outcome)).toMatch(/output was cut in the middle/);
  });

  it("warns about a tool call that was never awaited", async () => {
    const session = await startSession();
    const onHostRequest = vi.fn(echo);
    const outcome = await session.execute("r = tools.echo(text='x')", { timeoutMs: 5_000, onHostRequest });
    expect(outcome.stderr).toMatch(/never awaited and did not run/);
    expect(onHostRequest).not.toHaveBeenCalled();
  });

  it.skipIf(!hasDill)("snapshots variables and restores them in a new kernel", async () => {
    const snapshot = path.join(workDir, "snap.dill");
    const first = await startSession();
    await first.execute("import json\nclass Point:\n    def __init__(self, x): self.x = x\np = Point(3)\nsquare = lambda n: n * n", {
      timeoutMs: 10_000,
      onHostRequest: echo,
    });
    expect(await first.snapshot(snapshot)).toMatchObject({ status: "ok" });
    await first.shutdown();
    const second = await startSession();
    expect(await second.restore(snapshot)).toMatchObject({ status: "ok", failed: [] });
    const outcome = await second.execute("(p.x, square(4), json.dumps([1]))", { timeoutMs: 5_000, onHostRequest: echo });
    expect(outcome.result).toBe("(3, 16, '[1]')");
  });
});

describe("kernel bundle", () => {
  it("installs itself under the VM home and starts from there", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "mike-kernel-home-")));
    const bundle = kernelBundle();
    const command = kernelStartCommand(bundle);
    // One argument of an exec is capped at 128 KiB on Linux; keep well clear.
    expect(Buffer.byteLength(command)).toBeLessThan(64 * 1024);
    const session = await KernelSession.start(() =>
      spawn("bash", ["-c", command], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"] }),
    );
    sessions.push(session);
    expect(existsSync(path.join(home, ".mike", "kernel", bundle.hash, "mike_kernel", "repl.py"))).toBe(true);
    const outcome = await session.execute("import os\nos.getcwd()", { timeoutMs: 5_000, onHostRequest: echo });
    expect(outcome.result).toBe(JSON.stringify(home).replace(/"/g, "'"));
    await session.shutdown();
  });
});

describe("kernel manager", () => {
  it("marks a launcher down for a while after its kernel fails to start", async () => {
    let now = 1_000;
    const manager = new KernelManager({ downMs: 60_000, startTimeoutMs: 2_000, now: () => now });
    const broken: KernelLauncher = {
      id: "broken",
      spawn: () => spawn("false", [], { stdio: ["pipe", "pipe", "pipe"] }),
      snapshotPath: (key) => path.join(workDir, `${key}.dill`),
    };
    expect(manager.available(broken)).toBe(true);
    await expect(manager.acquire("conv", broken, [])).rejects.toThrow(/did not start/);
    expect(manager.available(broken)).toBe(false);
    now += 60_001;
    expect(manager.available(broken)).toBe(true);
  });

  it("stops idle kernels", async () => {
    let now = 0;
    const manager = new KernelManager({ idleMs: 1_000, now: () => now });
    const session = await manager.acquire("idle", launcher, []);
    now = 5_000;
    await manager.reapIdle();
    expect(session.alive).toBe(false);
  });
});

describe("python tool docs", () => {
  it("documents a tool as a Python signature, required parameters first", () => {
    const [spec] = pythonToolSpecs([
      {
        type: "function",
        function: {
          name: "find",
          description: "Find text.",
          parameters: {
            type: "object",
            properties: { limit: { type: "integer" }, query: { type: "string", description: "What to find." } },
            required: ["query"],
          },
        },
      },
      { type: "function", function: { name: "run_command", parameters: {} } },
    ]);
    const [read] = pythonToolSpecs([
      {
        type: "function",
        function: { name: "read_document", parameters: { type: "object", properties: { from: { type: "string" } } } },
      },
    ]);
    expect(pythonToolDoc(read)).toBe("await tools.read_document(from_: str = ...)\n    from_ (optional)");
    expect(pythonToolDoc(spec)).toBe(
      "await tools.find(query: str, limit: int = ...)\n    Find text.\n    query: What to find.\n    limit (optional)",
    );
  });
});
