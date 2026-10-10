/**
 * The harness side of the kernel's JSON-lines protocol (mike_kernel/PROTOCOL.md).
 *
 * Everything the kernel writes comes from inside the employee's VM, where
 * model-written code runs, so every line is parsed as untrusted input: a size
 * cap per line, and a shape check per event. A line that fails either is
 * dropped and counted, never thrown.
 */

export const KERNEL_PROTOCOL_VERSION = 1;
/** The kernel caps one frame near 8 MiB of payload; anything past this is not ours. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type KernelEvent =
  | { event: "ready"; protocol: number; python: string; pid: number }
  | { event: "stdout" | "stderr"; id: string | null; text: string }
  | { event: "result"; id: string; text: string }
  | { event: "display"; id: string | null; data: Record<string, unknown> }
  | { event: "host_request"; id: string; cell: string | null; data: Record<string, unknown> }
  | { event: "error"; id: string | null; ename: string; evalue: string; traceback: string[] }
  | { event: "done"; id: string; status: "ok" | "error"; [field: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isIdOrNull = (value: unknown): value is string | null => value === null || value === undefined || isString(value);

/** One parsed event, or null when the line is not a well-formed event. */
export function parseKernelEvent(line: string): KernelEvent | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;
  switch (frame.event) {
    case "ready":
      return typeof frame.protocol === "number"
        ? { event: "ready", protocol: frame.protocol, python: String(frame.python ?? ""), pid: Number(frame.pid) || 0 }
        : null;
    case "stdout":
    case "stderr":
      return isIdOrNull(frame.id) && isString(frame.text)
        ? { event: frame.event, id: frame.id ?? null, text: frame.text }
        : null;
    case "result":
      return isString(frame.id) && isString(frame.text) ? { event: "result", id: frame.id, text: frame.text } : null;
    case "display":
      return isIdOrNull(frame.id) && isRecord(frame.data)
        ? { event: "display", id: frame.id ?? null, data: frame.data }
        : null;
    case "host_request":
      return isString(frame.id) && isIdOrNull(frame.cell) && isRecord(frame.data)
        ? { event: "host_request", id: frame.id, cell: frame.cell ?? null, data: frame.data }
        : null;
    case "error":
      return isIdOrNull(frame.id)
        ? {
            event: "error",
            id: frame.id ?? null,
            ename: String(frame.ename ?? "Error"),
            evalue: String(frame.evalue ?? ""),
            traceback: Array.isArray(frame.traceback) ? frame.traceback.filter(isString) : [],
          }
        : null;
    case "done":
      return isString(frame.id) && (frame.status === "ok" || frame.status === "error")
        ? ({ ...frame, event: "done", id: frame.id, status: frame.status } as KernelEvent)
        : null;
    default:
      return null;
  }
}

/**
 * Splits a byte stream into lines without ever holding more than
 * MAX_LINE_BYTES of one line: an over-long line is skipped to its newline.
 */
export class LineSplitter {
  private chunks: Buffer[] = [];
  private size = 0;
  private skipping = false;
  oversized = 0;

  constructor(private readonly maxBytes = MAX_LINE_BYTES) {}

  push(chunk: Buffer, onLine: (line: string) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.skipping) {
        const piece = chunk.subarray(start, end);
        if (this.size + piece.length > this.maxBytes) {
          this.skipping = true;
          this.oversized += 1;
          this.chunks = [];
          this.size = 0;
        } else if (piece.length) {
          this.chunks.push(piece);
          this.size += piece.length;
        }
      }
      if (newline === -1) return;
      if (!this.skipping && this.size > 0) onLine(Buffer.concat(this.chunks).toString("utf8"));
      this.chunks = [];
      this.size = 0;
      this.skipping = false;
      start = newline + 1;
    }
  }
}
