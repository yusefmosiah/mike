import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestSnapshot, requestWipe, snapshotOncePerTurn } from "../snapshot";
import { connectVsockMux } from "../vsockMux";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A Unix-socket server in a temp dir; `onConnection` handles each connection. */
async function serve(onConnection: (socket: import("node:net").Socket) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ws-sock-"));
  const path = join(dir, "s.sock");
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

describe("connectVsockMux", () => {
  it("does the CONNECT handshake and hands back the stream, bytes after OK included", async () => {
    const path = await serve((socket) => {
      socket.once("data", (chunk) => {
        expect(chunk.toString()).toBe("CONNECT 22\n");
        socket.write("OK 1073741824\nSSH-2.0-guest\r\n");
        socket.on("data", (more) => socket.write(`echo:${more}`));
      });
    });
    const stream = await connectVsockMux(path, 22);
    const first = new Promise<string>((resolve) => stream.once("data", (d) => resolve(d.toString())));
    stream.resume();
    expect(await first).toBe("SSH-2.0-guest\r\n");
    stream.write("hi");
    const echoed = await new Promise<string>((resolve) => stream.once("data", (d) => resolve(d.toString())));
    expect(echoed).toBe("echo:hi");
    stream.destroy();
  });

  it("rejects a refused port", async () => {
    const path = await serve((socket) => socket.once("data", () => socket.end("ERROR no listener\n")));
    await expect(connectVsockMux(path, 2222)).rejects.toThrow(/refused/);
  });

  it("rejects a missing socket", async () => {
    await expect(connectVsockMux("/nonexistent/vm.sock", 22)).rejects.toThrow();
  });
});

describe("requestSnapshot", () => {
  it("sends one request line and reads the snapshot name", async () => {
    const seen: string[] = [];
    const path = await serve((socket) => socket.once("data", (d) => {
      seen.push(d.toString());
      socket.end("ok ws-owner/20261009T180000Z-turn\n");
    }));
    expect(await requestSnapshot(path, "ws-owner", "turn")).toEqual({ ok: true, snapshot: "ws-owner/20261009T180000Z-turn" });
    expect(seen).toEqual(["snapshot ws-owner turn\n"]);
  });

  it("reports the host's refusal and an absent service", async () => {
    const path = await serve((socket) => socket.once("data", () => socket.end("error rate limited\n")));
    expect(await requestSnapshot(path, "ws-owner", "turn")).toEqual({ ok: false, error: "rate limited" });
    expect(await requestSnapshot("/nonexistent/control.sock", "ws-owner", "turn")).toEqual({ ok: false, error: "workstation control service unavailable" });
  });
});

describe("requestWipe", () => {
  it("asks the host to wipe one VM", async () => {
    const seen: string[] = [];
    const path = await serve((socket) => socket.once("data", (d) => {
      seen.push(d.toString());
      socket.end("ok ws-02\n");
    }));
    expect(await requestWipe(path, "ws-02")).toEqual({ ok: true, snapshot: "ws-02" });
    expect(seen).toEqual(["wipe ws-02\n"]);
  });
});

describe("snapshotOncePerTurn", () => {
  it("snapshots on a turn's first command only", async () => {
    const request = vi.fn(async () => ({ ok: true as const, snapshot: "s" }));
    const turnA = new Map();
    const turnB = new Map();
    const target = { socketPath: "/run/x.sock", vm: "ws-owner" };
    await snapshotOncePerTurn(turnA, target, request);
    await snapshotOncePerTurn(turnA, target, request);
    await snapshotOncePerTurn(turnB, target, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await snapshotOncePerTurn(new Map(), undefined, request)).toBeNull();
  });
});
