// Every use and change of a secret, one JSON line each, in the state
// directory. Never the value; the request path is kept, the query string is
// not (it can carry tokens of its own).
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

export type AuditEvent = {
  at: string;
  user: string;
  event: "created" | "updated" | "deleted" | "lease" | "request" | "denied";
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

export class AuditLog {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, "audit.jsonl");
  }

  record(event: Omit<AuditEvent, "at">): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    this.queue = this.queue
      .then(async () => {
        const size = await stat(this.file).then((s) => s.size, () => 0);
        if (size > ROTATE_BYTES) await rename(this.file, `${this.file}.1`);
        await appendFile(this.file, line, { mode: 0o600 });
      })
      .catch((error) => console.error("audit write failed:", (error as Error).message));
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
