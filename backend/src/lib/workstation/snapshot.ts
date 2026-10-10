/**
 * Snapshots before the agent acts: the first `run_command` or `run_python`
 * cell of each turn asks the host to snapshot the workstation's disk, so
 * whatever the turn does (`rm -rf ~` included) can be rolled back to how it
 * started.
 *
 * The host side (infra/node-a/workstations.nix) is a Unix socket that takes
 * one line, `snapshot <vm> <label>`, and answers `ok <snapshot>` or
 * `error <reason>`; it flushes the guest, rate-limits and prunes. The same
 * socket takes `wipe <vm>` for a test account's temporary VM
 * (./assignments.ts). A failed snapshot is logged and the command still
 * runs: losing the safety net is worse than losing the command, but not by
 * enough to stop the user's work.
 */
import { connect } from "node:net";

export type SnapshotResult = { ok: true; snapshot: string } | { ok: false; error: string };

/** One request line to the host's control socket; the answer is `ok <detail>` or `error <reason>`. */
async function controlRequest(socketPath: string, line: string, timeoutMs: number): Promise<SnapshotResult> {
  return new Promise<SnapshotResult>((resolve) => {
    const socket = connect(socketPath);
    let reply = "";
    const finish = (result: SnapshotResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "request timed out" }), timeoutMs);
    socket.once("error", () => finish({ ok: false, error: "workstation control service unavailable" }));
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const newline = reply.indexOf("\n");
      if (newline === -1) return;
      const answer = reply.slice(0, newline).trim();
      if (answer.startsWith("ok ")) finish({ ok: true, snapshot: answer.slice(3) });
      else finish({ ok: false, error: answer.replace(/^error\s*/, "") || "request failed" });
    });
    socket.once("end", () => finish({ ok: false, error: "workstation control service closed the connection" }));
  });
}

export async function requestSnapshot(
  socketPath: string,
  vm: string,
  label: string,
  timeoutMs = 60_000,
): Promise<SnapshotResult> {
  return controlRequest(socketPath, `snapshot ${vm} ${label}`, timeoutMs);
}

/**
 * Erases a pool VM's home disk and snapshots (a test account's temporary VM)
 * and waits for the guest to come back up, which takes up to a few minutes.
 */
export async function requestWipe(socketPath: string, vm: string, timeoutMs = 280_000): Promise<SnapshotResult> {
  return controlRequest(socketPath, `wipe ${vm}`, timeoutMs);
}

const snapshotted = new WeakSet<object>();

/**
 * Snapshot once per turn. `turn` is any object that lives exactly as long as
 * the turn (the dispatcher passes the turn's edit state).
 */
export async function snapshotOncePerTurn(
  turn: object | undefined,
  snapshot: { socketPath: string; vm: string } | undefined,
  request: typeof requestSnapshot = requestSnapshot,
): Promise<SnapshotResult | null> {
  if (!snapshot || !turn || snapshotted.has(turn)) return null;
  snapshotted.add(turn);
  const result = await request(snapshot.socketPath, snapshot.vm, "turn");
  if (!result.ok) console.warn("[workstation] snapshot before turn failed", { vm: snapshot.vm, error: result.error });
  return result;
}
