import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { remoteCommandLine, runInWorkstation, shellQuote, sshArgs, type WorkstationTarget } from "../exec";

const target: WorkstationTarget = { host: "127.0.0.1", port: 2222, user: "agent", identityFile: "/keys/dev" };

/** A fake `spawn` that records its arguments and plays back a scripted run. */
function fakeSpawn(script: { stdout?: string; stderr?: string; code: number | null; hang?: boolean }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal: string) => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", null));
    setImmediate(() => {
      if (script.stdout) child.stdout.write(script.stdout);
      if (script.stderr) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      if (!script.hang) setImmediate(() => child.emit("close", script.code));
    });
    return child;
  }) as never;
  return { spawn, calls };
}

describe("shellQuote", () => {
  it("survives single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("remoteCommandLine", () => {
  it("bounds the command with timeout and runs it under bash in cwd", () => {
    expect(remoteCommandLine({ command: "ls -la", cwd: "/home/agent/repo" }, 30_000)).toBe(
      `timeout --kill-after=5s 30s bash -lc 'cd '\\''/home/agent/repo'\\'' && ls -la'`,
    );
  });
});

describe("sshArgs", () => {
  it("ignores user ssh config and never prompts", () => {
    const args = sshArgs(target, "true");
    expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-3)).toEqual(["agent@127.0.0.1", "--", "true"]);
  });

  it("uses a proxy command for vsock and checks host keys when given a file", () => {
    const args = sshArgs({ ...target, port: undefined, proxyCommand: "systemd-ssh-proxy vsock-mux/run/vm.sock 22", knownHostsFile: "/state/known" }, "true");
    expect(args).toContain("ProxyCommand=systemd-ssh-proxy vsock-mux/run/vm.sock 22");
    expect(args).toContain("ProxyUseFdpass=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("-p");
  });
});

describe("runInWorkstation", () => {
  it("returns exit code and output", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "hello\n", code: 0 });
    const result = await runInWorkstation(target, { command: "echo hello" }, { spawn });
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: "hello\n", timedOut: false, truncated: false });
    expect(calls[0].command).toBe("ssh");
  });

  it("reports a nonzero exit as a result, not an error", async () => {
    const { spawn } = fakeSpawn({ stderr: "No such file\n", code: 2 });
    const result = await runInWorkstation(target, { command: "cat missing" }, { spawn });
    expect(result).toMatchObject({ ok: true, exitCode: 2, stderr: "No such file\n" });
  });

  it("treats ssh's own failure as unreachable", async () => {
    const { spawn } = fakeSpawn({ stderr: "Connection refused", code: 255 });
    expect(await runInWorkstation(target, { command: "true" }, { spawn })).toEqual({ ok: false, error: "workstation unreachable" });
  });

  it("flags the remote timeout exit codes", async () => {
    const { spawn } = fakeSpawn({ code: 124 });
    const result = await runInWorkstation(target, { command: "sleep 999", timeoutMs: 1000 }, { spawn });
    expect(result).toMatchObject({ ok: true, timedOut: true });
  });

  it("keeps the start and end of long output", async () => {
    const { spawn } = fakeSpawn({ stdout: `START${"x".repeat(5000)}END`, code: 0 });
    const result = await runInWorkstation(target, { command: "big", maxOutputChars: 1000 }, { spawn });
    if (!result.ok) throw new Error("expected ok");
    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith("START")).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stdout).toContain("characters omitted");
  });

  it("refuses an empty command without connecting", async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    expect(await runInWorkstation(target, { command: "   " }, { spawn })).toEqual({ ok: false, error: "command is empty" });
    expect(calls).toHaveLength(0);
  });
});
