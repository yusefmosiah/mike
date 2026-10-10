/**
 * Keeps one kernel per conversation alive between turns, so variables a cell
 * defines are still there in the next message.
 *
 * A kernel lives in the backend process's memory as an ssh child. After every
 * cell it writes a snapshot of its variables inside the VM; when the backend
 * restarts (the kernel sees its stdin close and snapshots once more), when the
 * kernel dies, or after it was reaped for idleness, the next cell starts a new
 * kernel and restores that snapshot first.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { safeError } from "../../safeError";
import { sshArgs, type WorkstationTarget } from "../../workstation/exec";
import { kernelBundle, kernelStartCommand, KERNEL_PACKAGE_DIR } from "./bundle";
import { KernelSession, type KernelToolSpec } from "./session";

/** Where and how one user's kernels run. */
export type KernelLauncher = {
  /** Same id, same place: a conversation whose launcher changes gets a new kernel. */
  id: string;
  spawn: () => ChildProcessWithoutNullStreams;
  /** Path, as the kernel sees it, of a conversation's snapshot. */
  snapshotPath: (key: string) => string;
};

/** Kernels in the employee's workstation VM, over the same ssh channel as run_command. */
export function sshKernelLauncher(target: WorkstationTarget): KernelLauncher {
  const bundle = kernelBundle();
  return {
    id: `ssh:${target.user}@${target.host}:${target.port ?? 22}:${target.proxyCommand ?? ""}`,
    spawn: () => spawn("ssh", sshArgs(target, kernelStartCommand(bundle)), { stdio: ["pipe", "pipe", "pipe"] }),
    snapshotPath: (key) => `~/.mike/kernels/${key}.dill`,
  };
}

/**
 * Kernels as local python3 processes in `workDir`: tests, and development
 * without a VM. Never in production: the code would run on the backend host.
 */
export function localKernelLauncher(workDir: string, python = "python3"): KernelLauncher {
  return {
    id: `local:${workDir}`,
    spawn: () =>
      spawn(python, ["-u", "-m", "mike_kernel"], {
        cwd: workDir,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: workDir,
          PYTHONPATH: path.dirname(KERNEL_PACKAGE_DIR),
          // The package sits in the source tree; keep bytecode out of it.
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    snapshotPath: (key) => path.join(workDir, ".mike", "kernels", `${key}.dill`),
  };
}

type Entry = {
  launcherId: string;
  session: KernelSession;
  toolsHash: string;
  lastUsed: number;
  /** False once the kernel reports it cannot snapshot (no dill in the VM). */
  snapshots: boolean;
};

export type KernelManagerOptions = {
  /** A kernel unused this long is snapshotted and stopped. */
  idleMs?: number;
  /** After a kernel fails to start, its launcher counts as down this long. */
  downMs?: number;
  startTimeoutMs?: number;
  now?: () => number;
};

export const DEFAULT_KERNEL_IDLE_MS = 30 * 60_000;
const DEFAULT_DOWN_MS = 60_000;

/** A conversation key safe in a file name. */
export function kernelKey(raw: string): string {
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export class KernelManager {
  private entries = new Map<string, Entry>();
  private starting = new Map<string, Promise<Entry>>();
  private downUntil = new Map<string, number>();
  /** Conversations reset since their last snapshot: their next kernel starts empty. */
  private fresh = new Set<string>();
  private reaper: NodeJS.Timeout | null = null;
  private readonly idleMs: number;
  private readonly downMs: number;
  private readonly now: () => number;

  constructor(private readonly options: KernelManagerOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_KERNEL_IDLE_MS;
    this.downMs = options.downMs ?? DEFAULT_DOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /** False for a short while after this launcher's kernel failed to start. */
  available(launcher: KernelLauncher): boolean {
    return (this.downUntil.get(launcher.id) ?? 0) <= this.now();
  }

  /** The conversation's kernel, started (and restored) if needed, with this tool index bound. */
  async acquire(rawKey: string, launcher: KernelLauncher, tools: KernelToolSpec[]): Promise<KernelSession> {
    const key = kernelKey(rawKey);
    const toolsHash = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
    let entry = this.entries.get(key);
    if (entry && (!entry.session.alive || entry.launcherId !== launcher.id)) {
      if (entry.session.alive) void entry.session.shutdown();
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) entry = await this.start(key, launcher, tools, toolsHash);
    if (entry.toolsHash !== toolsHash) {
      await entry.session.configure(tools);
      entry.toolsHash = toolsHash;
    }
    entry.lastUsed = this.now();
    return entry.session;
  }

  private start(key: string, launcher: KernelLauncher, tools: KernelToolSpec[], toolsHash: string): Promise<Entry> {
    const already = this.starting.get(key);
    if (already) return already;
    const starting = (async () => {
      let session: KernelSession;
      try {
        session = await KernelSession.start(launcher.spawn, { startTimeoutMs: this.options.startTimeoutMs });
      } catch (error) {
        this.downUntil.set(launcher.id, this.now() + this.downMs);
        throw error;
      }
      this.downUntil.delete(launcher.id);
      const entry: Entry = { launcherId: launcher.id, session, toolsHash, lastUsed: this.now(), snapshots: true };
      await session.configure(tools);
      if (this.fresh.delete(key)) {
        this.entries.set(key, entry);
        this.startReaper();
        return entry;
      }
      try {
        const restored = await session.restore(launcher.snapshotPath(key));
        if (restored.status !== "ok") entry.snapshots = !/dill/i.test(String(restored.reason ?? ""));
        else if (Array.isArray(restored.restored) && restored.restored.length) {
          console.info("[code-mode] kernel restored", {
            restored: restored.restored.length,
            failed: Array.isArray(restored.failed) ? restored.failed.length : 0,
          });
        }
      } catch (error) {
        console.warn("[code-mode] kernel restore failed", safeError(error));
      }
      this.entries.set(key, entry);
      this.startReaper();
      return entry;
    })();
    this.starting.set(key, starting);
    return starting.finally(() => this.starting.delete(key));
  }

  /** After a cell: snapshot the conversation's variables. Not awaited by the turn. */
  async afterCell(rawKey: string, launcher: KernelLauncher): Promise<void> {
    const key = kernelKey(rawKey);
    const entry = this.entries.get(key);
    if (!entry || !entry.snapshots || !entry.session.alive) return;
    try {
      const done = await entry.session.snapshot(launcher.snapshotPath(key));
      if (done.status !== "ok") {
        if (/dill/i.test(String(done.reason ?? ""))) entry.snapshots = false;
        console.warn("[code-mode] kernel snapshot failed", { reason: String(done.reason ?? "").slice(0, 200) });
      }
    } catch (error) {
      console.warn("[code-mode] kernel snapshot failed", safeError(error));
    }
  }

  /**
   * Stops a conversation's kernel without a final snapshot (`reset`). The
   * next kernel starts empty, and its first cell's snapshot replaces the old.
   */
  discard(rawKey: string): void {
    const key = kernelKey(rawKey);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    this.fresh.add(key);
    entry?.session.kill();
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, this.idleMs));
    this.reaper.unref();
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    for (const [key, entry] of [...this.entries]) {
      if (entry.lastUsed > cutoff && entry.session.alive) continue;
      this.entries.delete(key);
      // Closing stdin makes the kernel write its final snapshot before it exits.
      await entry.session.shutdown().catch(() => undefined);
    }
    if (this.entries.size === 0 && this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  /** Every kernel, politely (tests, process shutdown). */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.session.shutdown().catch(() => undefined)));
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }
}
