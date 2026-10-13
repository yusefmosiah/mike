// Removes every form of a secret from a byte stream, including occurrences
// split across chunks.
import { Transform, type TransformCallback } from "node:stream";

export const REDACTED = "[redacted by vault]";

export function scrubText(text: string, patterns: string[]): string {
  let out = text;
  for (const pattern of patterns) out = out.split(pattern).join(REDACTED);
  return out;
}

export class Scrubber extends Transform {
  private carry = "";
  private readonly patterns: string[];
  private readonly keep: number;

  constructor(patterns: string[]) {
    super();
    // Bytes as latin1 map one-to-one onto characters, so binary bodies
    // survive the round trip and multi-byte secrets still match.
    this.patterns = patterns.map((p) => Buffer.from(p, "utf8").toString("latin1"));
    this.keep = Math.max(0, ...this.patterns.map((p) => p.length - 1));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const text = scrubText(this.carry + chunk.toString("latin1"), this.patterns);
    const cut = Math.max(0, text.length - this.keep);
    this.carry = text.slice(cut);
    if (cut > 0) this.push(Buffer.from(text.slice(0, cut), "latin1"));
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.carry) this.push(Buffer.from(scrubText(this.carry, this.patterns), "latin1"));
    done();
  }
}
