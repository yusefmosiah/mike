// Every use and change of a secret, one JSON line each, in the state
// directory. Never the value; the request path is kept, the query string is
// not (it can carry tokens of its own).
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

export type AuditEvent = {
  at: string;
  user: string;
  event: "created" | "updated" | "deleted" | "purged" | "allowed" | "lease" | "request" | "denied";
  secret?: string;
  secret_name?: string;
  vm?: string;
  chat?: string | null;
  access?: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  reason?: string;
};

const ROTATE_BYTES = 20 * 1024 * 1024;
/** Lines waiting for the disk; beyond this, events are counted and dropped. */
const MAX_PENDING = 10_000;

export class AuditLog {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private dropped = 0;
  private failedAt = 0;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.file = path.join(dir, "audit.jsonl");
    this.now = now;
  }

  /**
   * True while the backlog is full, or for a minute after a write failed:
   * callers refuse work rather than let it go unlogged.
   */
  saturated(): boolean {
    return this.pending >= MAX_PENDING || (this.failedAt > 0 && this.now() - this.failedAt < 60_000);
  }

  /**
   * Appends one event. Resolves true once it is on disk, false if it could
   * not be written (never rejects): a caller that must not act unlogged
   * awaits it first.
   */
  record(event: Omit<AuditEvent, "at">): Promise<boolean> {
    if (this.pending >= MAX_PENDING) {
      if (this.dropped++ % 1000 === 0) console.error(`audit backlog full; ${this.dropped} event(s) dropped`);
      return Promise.resolve(false);
    }
    this.pending++;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    const written = this.queue
      .then(async () => {
        const size = await stat(this.file).then((s) => s.size, () => 0);
        if (size > ROTATE_BYTES) await rename(this.file, `${this.file}.1`);
        await appendFile(this.file, line, { mode: 0o600 });
        return true;
      })
      .catch((error) => {
        this.failedAt = this.now();
        console.error("audit write failed:", (error as Error).message);
        return false;
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = written;
    return written;
  }

  /** The user's most recent events, newest first. */
  async recent(userId: string, limit: number): Promise<AuditEvent[]> {
    await this.queue;
    const lines = await readFile(this.file, "utf8").catch(() => "");
    const out: AuditEvent[] = [];
    const all = lines.split("\n");
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      if (!all[i]) continue;
      try {
        const event = JSON.parse(all[i]) as AuditEvent;
        if (event.user === userId) out.push(event);
      } catch {
        /* a torn last line */
      }
    }
    return out;
  }
}
