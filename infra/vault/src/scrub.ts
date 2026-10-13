// Removes every form of a secret from a byte stream, including occurrences
// split across chunks. Text is handled as latin1, one character per byte, so
// binary bodies pass through unchanged except where the secret is.
import { Transform, type TransformCallback } from "node:stream";
import type { ScrubSpec } from "./policy.ts";

export const REDACTED = "[redacted by vault]";

/** Where the secret appears in `text`: every match of the expression and of each literal form, merged. */
function spans(text: string, spec: ScrubSpec): [number, number][] {
  const found: [number, number][] = [];
  spec.expression.lastIndex = 0;
  for (const match of text.matchAll(spec.expression)) {
    if (match[0].length > 0) found.push([match.index, match.index + match[0].length]);
  }
  for (const pattern of spec.patterns) {
    for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
      found.push([at, at + pattern.length]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function redact(text: string, ranges: [number, number][], upTo = text.length): string {
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (start >= upTo) break;
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at, upTo);
}

/** Removes the secret from `text` (latin1 view, or plain text for ASCII). */
export function scrubText(text: string, spec: ScrubSpec): string {
  return redact(text, spans(text, spec));
}

/**
 * Numeric character references, finished or cut off at the end. Their
 * leading zeros can run on without limit (`&#00097;` is `a`), so a stream
 * measures what it holds back in references, not bytes.
 */
const REFERENCE = /&#(?:x0*[0-9a-f]{0,6}|0*[0-9]{0,7});?/gi;
/**
 * Never hold back more than this: well beyond what any secret's forms need,
 * and small enough that re-checking it on every chunk stays cheap.
 */
const maxPending = (window: number) => Math.max(4 * window, 256 * 1024);

/**
 * Where to stop sending: `need` characters back from the end, counting a
 * numeric reference of any length as at most 11 (its longest unpadded form).
 */
function holdBackStart(text: string, need: number): number {
  const references = [...text.matchAll(REFERENCE)].map((m) => [m.index, m.index + m[0].length]);
  let at = text.length;
  let cost = 0;
  let r = references.length - 1;
  while (at > 0 && cost < need) {
    while (r >= 0 && references[r][0] >= at) r--;
    if (r >= 0 && references[r][1] === at) {
      at = references[r][0];
      cost += Math.min(11, references[r][1] - references[r][0]);
      r--;
    } else {
      at--;
      cost++;
    }
  }
  return at;
}

export class Scrubber extends Transform {
  /** Raw text not yet sent: it could still be part of a match. */
  private pending = "";
  private readonly spec: ScrubSpec;
  /** How much of the end could still grow into a match. */
  private readonly holdBack: number;
  private readonly maxPending: number;

  constructor(spec: ScrubSpec) {
    super();
    this.spec = spec;
    // A match's base64 edges can extend it a few characters past where it
    // first matches; hold those back too.
    this.holdBack = spec.window + 8;
    this.maxPending = maxPending(spec.window);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const text = this.pending + chunk.toString("latin1");
    const ranges = spans(text, this.spec);
    // Send everything that no match still open at the end can reach. A match
    // that runs past that point is held back whole, not cut. Nothing is
    // rewritten: bytes are sent as they came, or replaced by the marker.
    let cut = holdBackStart(text, this.holdBack);
    for (const [start, end] of ranges) {
      if (start < cut && end > cut) cut = start;
    }
    this.pending = text.slice(cut);
    if (this.pending.length > this.maxPending) {
      // Only a response built to defeat the scrubber gets here: end it
      // rather than send what could not be checked.
      done(new Error("the response could not be checked for the secret"));
      return;
    }
    if (cut > 0) this.push(Buffer.from(redact(text, ranges, cut), "latin1"));
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.pending) this.push(Buffer.from(scrubText(this.pending, this.spec), "latin1"));
    done();
  }
}
