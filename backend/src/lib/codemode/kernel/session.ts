/**
 * One running kernel (mike_kernel) and the conversation with it.
 *
 * The kernel is a child process: ssh into the employee's workstation VM in
 * production, or a local python3 in tests and on a developer's machine. A
 * session runs one request at a time; `execute` resolves with the cell's
 * output once the kernel reports it done, the time limit passes, or the
 * caller aborts.
 *
 * The time limit counts the cell's own running time only: while a tool call
 * the cell made is with the harness (a slow web fetch, a model call), the
 * clock stops, because that time is not the cell's to spend.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Capped } from "../../workstation/exec";
import { KERNEL_PROTOCOL_VERSION, LineSplitter, parseKernelEvent, type KernelEvent } from "./protocol";

export type KernelToolSpec = { name: string; description?: string; parameters?: unknown };

/** What the harness answers a host request with (PROTOCOL.md, "Host requests"). */
export type HostReply =
  | { ok: true; content: string }
  | { ok: false; error: string }
  | { paused: true; message: string };

export type HostRequestHandler = (data: Record<string, unknown>) => Promise<HostReply>;

export type CellOutcome = {
  status: "ok" | "error";
  stdout: string;
  stderr: string;
  /** repr() of the cell's last expression. */
  result: string | null;
  /** Text forms of what the cell sent with emit(). */
  displays: string[];
  error: { ename: string; evalue: string; traceback: string[] } | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** The kernel died or had to be killed; the next cell starts a new one. */
  kernelLost: boolean;
  hostRequests: number;
  durationMs: number;
};

export type ExecuteOptions = {
  timeoutMs: number;
  onHostRequest: HostRequestHandler;
  signal?: AbortSignal;
  maxOutputChars?: number;
};

export const DEFAULT_KERNEL_START_TIMEOUT_MS = 30_000;
/** After an interrupt, how long a cell gets to stop before the kernel is killed. */
export const INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;

type Pending = {
  onEvent: (event: KernelEvent) => void;
  onLost: () => void;
};

export class KernelError extends Error {}

export class KernelSession {
  private pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private diagnostics = new Capped(4_000);
  private exited = false;
  private readyWaiter: ((event: KernelEvent | null) => void) | null = null;
  /** The cell currently running, for output the kernel could not attribute. */
  private runningCell: string | null = null;
  python = "";
  droppedLines = 0;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const splitter = new LineSplitter();
    child.stdout.on("data", (chunk: Buffer) =>
      splitter.push(chunk, (line) => {
        const event = parseKernelEvent(line);
        if (!event) {
          this.droppedLines += 1;
          return;
        }
        this.dispatch(event);
      }),
    );
    child.stderr.setEncoding("utf8").on("data", (text: string) => this.diagnostics.push(text));
    child.stdin.on("error", () => undefined);
    const lost = () => {
      if (this.exited) return;
      this.exited = true;
      this.readyWaiter?.(null);
      for (const pending of [...this.pending.values()]) pending.onLost();
      this.pending.clear();
    };
    child.on("exit", lost);
    child.on("error", lost);
  }

  /** Spawns the process and waits for the kernel's `ready` line. */
  static async start(
    spawnKernel: () => ChildProcessWithoutNullStreams,
    options: { startTimeoutMs?: number } = {},
  ): Promise<KernelSession> {
    const session = new KernelSession(spawnKernel());
    const ready = await new Promise<KernelEvent | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), options.startTimeoutMs ?? DEFAULT_KERNEL_START_TIMEOUT_MS);
      session.readyWaiter = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
    session.readyWaiter = null;
    if (!ready || ready.event !== "ready") {
      session.kill();
      throw new KernelError("the kernel did not start");
    }
    if (ready.protocol !== KERNEL_PROTOCOL_VERSION) {
      session.kill();
      throw new KernelError(`kernel protocol ${ready.protocol} is not ${KERNEL_PROTOCOL_VERSION}`);
    }
    session.python = ready.python;
    return session;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** The last few thousand characters the process wrote to stderr (ssh and kernel diagnostics). */
  get stderrTail(): string {
    return this.diagnostics.toString();
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private dispatch(event: KernelEvent): void {
    if (event.event === "ready") {
      this.readyWaiter?.(event);
      return;
    }
    const target = event.event === "host_request" ? event.cell : event.id;
    const pending = this.pending.get(target ?? this.runningCell ?? "");
    if (pending) {
      pending.onEvent(event);
      return;
    }
    if (event.event === "host_request") {
      // A task the cell left running asks for a tool after the cell ended:
      // nobody is accountable for that call, so it is refused.
      this.send({ type: "host_reply", id: event.id, data: { ok: false, error: "no cell is running" } });
    }
  }

  private send(request: Record<string, unknown>): void {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  /** Runs one request after the ones before it. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A request answered by one `done` event: configure, snapshot, restore, list_names. */
  private request(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.serial(
      () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          if (this.exited) return reject(new KernelError("the kernel is not running"));
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new KernelError(`${type} timed out`));
          }, REQUEST_TIMEOUT_MS);
          this.pending.set(id, {
            onEvent: (event) => {
              if (event.event !== "done") return;
              clearTimeout(timer);
              this.pending.delete(id);
              resolve(event);
            },
            onLost: () => {
              clearTimeout(timer);
              reject(new KernelError("the kernel exited"));
            },
          });
          this.send({ type, id, ...fields });
        }),
    );
  }

  configure(tools: KernelToolSpec[]): Promise<Record<string, unknown>> {
    return this.request("configure", { tools });
  }

  snapshot(path: string, limits: { maxBytes?: number; maxVariableBytes?: number } = {}): Promise<Record<string, unknown>> {
    return this.request("snapshot", { path, max_bytes: limits.maxBytes, max_variable_bytes: limits.maxVariableBytes });
  }

  restore(path: string): Promise<Record<string, unknown>> {
    return this.request("restore", { path });
  }

  listNames(): Promise<string[]> {
    return this.request("list_names").then((done) => (Array.isArray(done.names) ? done.names.map(String) : []));
  }

  /** Ends the kernel politely (it takes its final snapshot on the way out), then for certain. */
  async shutdown(graceMs = 10_000): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), graceMs);
    await exited;
    clearTimeout(timer);
  }

  execute(code: string, options: ExecuteOptions): Promise<CellOutcome> {
    return this.serial(() => this.runCell(code, options));
  }

  private runCell(code: string, options: ExecuteOptions): Promise<CellOutcome> {
    const started = Date.now();
    const maxChars = Math.max(1_000, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
    const stdout = new Capped(maxChars);
    const stderr = new Capped(maxChars);
    const displays: string[] = [];
    let result: string | null = null;
    let error: CellOutcome["error"] = null;
    let timedOut = false;
    let aborted = false;
    let hostRequests = 0;
    let inFlight = 0;

    return new Promise<CellOutcome>((resolve) => {
      if (this.exited) {
        resolve(outcome("error", true, { ename: "KernelLost", evalue: "the kernel is not running", traceback: [] }));
        return;
      }
      const id = randomUUID();
      let remaining = Math.max(1_000, options.timeoutMs);
      let clockStarted = Date.now();
      let timer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let finished = false;

      function outcome(status: CellOutcome["status"], kernelLost: boolean, failure = error): CellOutcome {
        return {
          status,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          result,
          displays,
          error: failure,
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
          aborted,
          kernelLost,
          hostRequests,
          durationMs: Date.now() - started,
        };
      }
      const finish = (status: CellOutcome["status"], kernelLost = false) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (this.runningCell === id) this.runningCell = null;
        resolve(outcome(status, kernelLost));
      };
      const stop = () => {
        this.send({ type: "interrupt", id });
        killTimer ??= setTimeout(() => {
          this.kill();
          finish("error", true);
        }, INTERRUPT_GRACE_MS);
      };
      const startClock = () => {
        clockStarted = Date.now();
        timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, remaining);
      };
      const pauseClock = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        remaining = Math.max(0, remaining - (Date.now() - clockStarted));
      };
      const onAbort = () => {
        aborted = true;
        stop();
      };

      this.pending.set(id, {
        onEvent: (event) => {
          switch (event.event) {
            case "stdout":
              stdout.push(event.text);
              break;
            case "stderr":
              stderr.push(event.text);
              break;
            case "result":
              result = event.text.length > maxChars ? `${event.text.slice(0, maxChars)} [... truncated ...]` : event.text;
              break;
            case "display":
              displays.push(displayText(event.data, maxChars));
              break;
            case "error":
              error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback };
              break;
            case "host_request": {
              hostRequests += 1;
              if (inFlight++ === 0 && !timedOut && !aborted) pauseClock();
              const requestId = event.id;
              void options
                .onHostRequest(event.data)
                .catch((): HostReply => ({ ok: false, error: "the tool call failed" }))
                .then((reply) => {
                  this.send({ type: "host_reply", id: requestId, data: reply });
                  if (--inFlight === 0 && !finished && !timedOut && !aborted) startClock();
                });
              break;
            }
            case "done":
              finish(event.status);
              break;
          }
        },
        onLost: () => {
          error ??= { ename: "KernelLost", evalue: "the kernel exited while the cell was running", traceback: [] };
          finish("error", true);
        },
      });
      this.runningCell = id;
      if (options.signal?.aborted) {
        aborted = true;
        finish("error");
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ type: "execute", id, code });
      startClock();
    });
  }
}

/** The text form of one emit() payload: text MIME types inline, others named. */
export function displayText(data: Record<string, unknown>, maxChars: number): string {
  const parts: string[] = [];
  for (const [mime, value] of Object.entries(data)) {
    if (mime.startsWith("text/") || mime === "application/json") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      parts.push(text.length > maxChars ? `${text.slice(0, maxChars)} [... truncated ...]` : text);
    } else {
      const size = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
      parts.push(`[${mime}, ${size} characters, not shown]`);
    }
  }
  return parts.join("\n");
}
