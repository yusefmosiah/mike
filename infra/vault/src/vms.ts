// Which VMs may be lent anything.
//
// A guest in a shared thread can run commands in the host's VM, and what a
// guest runs can stay behind (a background process, a git hook) and use a
// lease the owner gets later. So when a guest's turn starts in a VM, the
// backend fences it: everything lent to it is revoked, nothing new is lent
// while the turn runs, and the VM is marked as having had a guest. Leases
// stay off until the owner allows them again (Settings → Vault) or the VM is
// wiped. The fence and the lease check run in the same event-loop turn, so a
// lease cannot slip in between them.
//
// Marks are kept on disk; running guest turns are not (a restart ends them).
import { mkdir, open as openFile, readFile, rename } from "node:fs/promises";
import path from "node:path";

type VmFile = { version: 1; guested: Record<string, { since: string }> };

export class VmGuard {
  private readonly file: string;
  private data: VmFile = { version: 1, guested: {} };
  private readonly guests = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, "vms.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as VmFile;
      if (parsed.version !== 1 || typeof parsed.guested !== "object") throw new Error("unknown vms.json version");
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const run = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const handle = await openFile(tmp, "w", 0o600);
      try {
        await handle.writeFile(snapshot);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.file);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Why nothing may be lent to `vm` now, or null. */
  blocked(vm: string): string | null {
    if ((this.guests.get(vm) ?? 0) > 0) {
      return "Someone else is working in this workstation right now, so nothing can be lent to it until they finish.";
    }
    if (this.data.guested[vm]) {
      return "Someone else has worked in this workstation, so stored credentials are paused for it. The user can allow them again in Settings → Vault.";
    }
    return null;
  }

  /**
   * Starts a fence: nothing is lent to `vm` until `unfence`. The in-memory
   * part takes effect before this returns a promise; with `mark`, the VM
   * also stays paused afterwards, and the mark is on disk when it resolves.
   */
  fence(vm: string, mark: boolean): Promise<void> {
    this.guests.set(vm, (this.guests.get(vm) ?? 0) + 1);
    if (!mark || this.data.guested[vm]) return Promise.resolve();
    this.data.guested[vm] = { since: new Date().toISOString() };
    return this.persist();
  }

  unfence(vm: string): void {
    const left = (this.guests.get(vm) ?? 0) - 1;
    if (left > 0) this.guests.set(vm, left);
    else this.guests.delete(vm);
  }

  /** Lifts the mark: the owner allowed leases again, or the VM was wiped. */
  async clear(vm: string): Promise<void> {
    if (!this.data.guested[vm]) return;
    delete this.data.guested[vm];
    await this.persist();
  }

  state(vm: string): { guests: number; guested_since: string | null } {
    return { guests: this.guests.get(vm) ?? 0, guested_since: this.data.guested[vm]?.since ?? null };
  }
}
