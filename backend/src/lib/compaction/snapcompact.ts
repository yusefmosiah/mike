// Snapcompact: turn a dropped slice of conversation into PNG "archive frames"
// a vision model can read.
//
// Everything here is pure and deterministic — no native canvas, no LLM call,
// no timestamps inside the image. A 5x7 bitmap font is drawn into a
// fixed-pitch grid and encoded as a grayscale PNG by hand (node:zlib for the
// IDAT deflate stream, our own CRC32 for the chunk checksums), so the same
// input yields byte-identical output on every machine.

import { deflateSync } from "node:zlib";
import { looksLikeErrorOrRecovery, type CompactTurn } from "./policy";

/** Hard bound on frames per compaction; the archive is compressed first. */
export const MAX_ARCHIVE_FRAMES = 8;

/** Target characters per frame before pagination splits the archive. */
export const ARCHIVE_FRAME_CHARS = 6000;

export type ArchiveFrame = {
  image: Buffer;
  mimeType: "image/png";
  fallbackText: string;
};

/**
 * Flatten turns into the archived text: one header per turn, body verbatim.
 * Turn order is preserved exactly as given, so a tool result keeps its
 * position directly after the tool call it answers.
 */
export function serializeTurnsForArchive(
  turns: readonly CompactTurn[],
): string {
  return turns
    .map(
      (turn, index) =>
        `--- [turn ${index + 1} | ${turn.role}] ---\n${turn.text}\n`,
    )
    .join("\n");
}

/**
 * Split text into frames at line boundaries (a pathological single line is
 * hard-cut), keeping `pages.join("") === text` so every character survives in
 * some frame's fallbackText. Surrogate pairs are never split across frames.
 */
export function paginateArchive(
  text: string,
  maxCharsPerFrame: number = ARCHIVE_FRAME_CHARS,
): string[] {
  if (!(maxCharsPerFrame >= 1)) {
    throw new RangeError("maxCharsPerFrame must be >= 1");
  }
  const pages: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= maxCharsPerFrame) {
      pages.push(text.slice(offset));
      break;
    }
    const newlineAt = text.lastIndexOf("\n", offset + maxCharsPerFrame - 1);
    // Break after a newline only when it sits in the back half of the window;
    // a newline near the start (e.g. right after a long turn header) would
    // otherwise emit a near-empty frame and burn the frame budget.
    let end =
      newlineAt > offset + Math.floor(maxCharsPerFrame / 2)
        ? newlineAt + 1
        : offset + maxCharsPerFrame;
    // Keep a surrogate pair together; the newline path can't split one.
    const last = text.charCodeAt(end - 1);
    if (end > offset + 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pages.push(text.slice(offset, end));
    offset = end;
  }
  return pages;
}

/** User requests and error/recovery turns survive frame-pressure drops. */
export function isArchiveAnchor(turn: CompactTurn): boolean {
  return turn.role === "user" || looksLikeErrorOrRecovery(turn.text);
}

/**
 * Drop the oldest non-anchor turns until the archive fits the frame bound.
 * Anchors (user requests, errors/recovery) are never dropped here; if anchors
 * alone overflow, `framesForArchive` keeps every character on a final frame.
 */
export function compressArchiveTurns(
  turns: readonly CompactTurn[],
  maxFrames: number = MAX_ARCHIVE_FRAMES,
): CompactTurn[] {
  const current = [...turns];
  while (
    current.length > 0 &&
    paginateArchive(serializeTurnsForArchive(current)).length > maxFrames
  ) {
    const dropAt = current.findIndex((turn) => !isArchiveAnchor(turn));
    if (dropAt === -1) break;
    current.splice(dropAt, 1);
  }
  return current;
}

/**
 * Render an archive into at most `MAX_ARCHIVE_FRAMES` PNG frames. When even a
 * compressed archive overflows, the remainder rides on the final frame rather
 * than being dropped — `fallbackText` is always the source text chunk itself,
 * so the frames concatenate back to the exact input text.
 */
export function framesForArchive(text: string): ArchiveFrame[] {
  let pages = paginateArchive(text);
  if (pages.length > MAX_ARCHIVE_FRAMES) {
    pages = [
      ...pages.slice(0, MAX_ARCHIVE_FRAMES - 1),
      pages.slice(MAX_ARCHIVE_FRAMES - 1).join(""),
    ];
  }
  return pages.map((page) => ({
    image: renderFramePng(page),
    mimeType: "image/png" as const,
    fallbackText: page,
  }));
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

const FRAME_COLS = 80;
const FRAME_CHAR_W = 8;
const FRAME_CHAR_H = 16;
const FRAME_PADDING = 8;
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_X_OFFSET = 1;
const GLYPH_Y_OFFSET = 4;
const BACKGROUND = 0xff;
const FOREGROUND = 0x00;

// Classic 5x7 font, five column bytes per glyph, bit 0 = top row; index 0 is
// 0x20 (space). Only printable ASCII is defined; everything else draws '?'.
const FONT_5X7: ReadonlyArray<readonly number[]> = [
  [0x00, 0x00, 0x00, 0x00, 0x00], // space
  [0x00, 0x00, 0x5f, 0x00, 0x00], // !
  [0x00, 0x07, 0x00, 0x07, 0x00], // "
  [0x14, 0x7f, 0x14, 0x7f, 0x14], // #
  [0x24, 0x2a, 0x7f, 0x2a, 0x12], // $
  [0x23, 0x13, 0x08, 0x64, 0x62], // %
  [0x36, 0x49, 0x55, 0x22, 0x50], // &
  [0x00, 0x05, 0x03, 0x00, 0x00], // '
  [0x00, 0x1c, 0x22, 0x41, 0x00], // (
  [0x00, 0x41, 0x22, 0x1c, 0x00], // )
  [0x14, 0x08, 0x3e, 0x08, 0x14], // *
  [0x08, 0x08, 0x3e, 0x08, 0x08], // +
  [0x00, 0x50, 0x30, 0x00, 0x00], // ,
  [0x08, 0x08, 0x08, 0x08, 0x08], // -
  [0x00, 0x60, 0x60, 0x00, 0x00], // .
  [0x20, 0x10, 0x08, 0x04, 0x02], // /
  [0x3e, 0x51, 0x49, 0x45, 0x3e], // 0
  [0x00, 0x42, 0x7f, 0x40, 0x00], // 1
  [0x42, 0x61, 0x51, 0x49, 0x46], // 2
  [0x21, 0x41, 0x45, 0x4b, 0x31], // 3
  [0x18, 0x14, 0x12, 0x7f, 0x10], // 4
  [0x27, 0x45, 0x45, 0x45, 0x39], // 5
  [0x3c, 0x4a, 0x49, 0x49, 0x30], // 6
  [0x01, 0x71, 0x09, 0x05, 0x03], // 7
  [0x36, 0x49, 0x49, 0x49, 0x36], // 8
  [0x06, 0x49, 0x49, 0x29, 0x1e], // 9
  [0x00, 0x36, 0x36, 0x00, 0x00], // :
  [0x00, 0x56, 0x36, 0x00, 0x00], // ;
  [0x08, 0x14, 0x22, 0x41, 0x00], // <
  [0x14, 0x14, 0x14, 0x14, 0x14], // =
  [0x00, 0x41, 0x22, 0x14, 0x08], // >
  [0x02, 0x01, 0x51, 0x09, 0x06], // ?
  [0x32, 0x49, 0x79, 0x41, 0x3e], // @
  [0x7e, 0x11, 0x11, 0x11, 0x7e], // A
  [0x7f, 0x49, 0x49, 0x49, 0x36], // B
  [0x3e, 0x41, 0x41, 0x41, 0x22], // C
  [0x7f, 0x41, 0x41, 0x22, 0x1c], // D
  [0x7f, 0x49, 0x49, 0x49, 0x41], // E
  [0x7f, 0x09, 0x09, 0x01, 0x01], // F
  [0x3e, 0x41, 0x41, 0x51, 0x32], // G
  [0x7f, 0x08, 0x08, 0x08, 0x7f], // H
  [0x00, 0x41, 0x7f, 0x41, 0x00], // I
  [0x20, 0x40, 0x41, 0x3f, 0x01], // J
  [0x7f, 0x08, 0x14, 0x22, 0x41], // K
  [0x7f, 0x40, 0x40, 0x40, 0x40], // L
  [0x7f, 0x02, 0x04, 0x02, 0x7f], // M
  [0x7f, 0x04, 0x08, 0x10, 0x7f], // N
  [0x3e, 0x41, 0x41, 0x41, 0x3e], // O
  [0x7f, 0x09, 0x09, 0x09, 0x06], // P
  [0x3e, 0x41, 0x51, 0x21, 0x5e], // Q
  [0x7f, 0x09, 0x19, 0x29, 0x46], // R
  [0x46, 0x49, 0x49, 0x49, 0x31], // S
  [0x01, 0x01, 0x7f, 0x01, 0x01], // T
  [0x3f, 0x40, 0x40, 0x40, 0x3f], // U
  [0x1f, 0x20, 0x40, 0x20, 0x1f], // V
  [0x7f, 0x20, 0x18, 0x20, 0x7f], // W
  [0x63, 0x14, 0x08, 0x14, 0x63], // X
  [0x03, 0x04, 0x78, 0x04, 0x03], // Y
  [0x61, 0x51, 0x49, 0x45, 0x43], // Z
  [0x00, 0x7f, 0x41, 0x41, 0x00], // [
  [0x02, 0x04, 0x08, 0x10, 0x20], // backslash
  [0x00, 0x41, 0x41, 0x7f, 0x00], // ]
  [0x04, 0x02, 0x01, 0x02, 0x04], // ^
  [0x40, 0x40, 0x40, 0x40, 0x40], // _
  [0x00, 0x01, 0x02, 0x04, 0x00], // `
  [0x20, 0x54, 0x54, 0x54, 0x78], // a
  [0x7f, 0x48, 0x44, 0x44, 0x38], // b
  [0x38, 0x44, 0x44, 0x44, 0x20], // c
  [0x38, 0x44, 0x44, 0x48, 0x7f], // d
  [0x38, 0x54, 0x54, 0x54, 0x18], // e
  [0x08, 0x7e, 0x09, 0x01, 0x02], // f
  [0x08, 0x14, 0x54, 0x54, 0x3c], // g
  [0x7f, 0x08, 0x04, 0x04, 0x78], // h
  [0x00, 0x44, 0x7d, 0x40, 0x00], // i
  [0x20, 0x40, 0x44, 0x3d, 0x00], // j
  [0x00, 0x7f, 0x10, 0x28, 0x44], // k
  [0x00, 0x41, 0x7f, 0x40, 0x00], // l
  [0x7c, 0x04, 0x18, 0x04, 0x78], // m
  [0x7c, 0x08, 0x04, 0x04, 0x78], // n
  [0x38, 0x44, 0x44, 0x44, 0x38], // o
  [0x7c, 0x14, 0x14, 0x14, 0x08], // p
  [0x08, 0x14, 0x14, 0x18, 0x7c], // q
  [0x7c, 0x08, 0x04, 0x04, 0x08], // r
  [0x48, 0x54, 0x54, 0x54, 0x20], // s
  [0x04, 0x3f, 0x44, 0x40, 0x20], // t
  [0x3c, 0x40, 0x40, 0x20, 0x7c], // u
  [0x1c, 0x20, 0x40, 0x20, 0x1c], // v
  [0x3c, 0x40, 0x30, 0x40, 0x3c], // w
  [0x44, 0x28, 0x10, 0x28, 0x44], // x
  [0x0c, 0x50, 0x50, 0x50, 0x3c], // y
  [0x44, 0x64, 0x54, 0x4c, 0x44], // z
  [0x00, 0x08, 0x36, 0x41, 0x00], // {
  [0x00, 0x00, 0x7f, 0x00, 0x00], // |
  [0x00, 0x41, 0x36, 0x08, 0x00], // }
  [0x08, 0x04, 0x08, 0x10, 0x08], // ~
];

const QUESTION_GLYPH = FONT_5X7[0x3f - 0x20];

function glyphFor(codePoint: number): readonly number[] {
  return codePoint >= 0x20 && codePoint <= 0x7e
    ? FONT_5X7[codePoint - 0x20]
    : QUESTION_GLYPH;
}

function wrapFrameLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const lines: string[] = [];
  for (const line of normalized.split("\n")) {
    if (line.length === 0) {
      lines.push("");
      continue;
    }
    for (let start = 0; start < line.length; start += FRAME_COLS) {
      lines.push(line.slice(start, start + FRAME_COLS));
    }
  }
  return lines;
}

/** Rasterize text into a grayscale PNG on an 80x(dynamic) cell grid. */
export function renderFramePng(text: string): Buffer {
  const lines = wrapFrameLines(text);
  const width = FRAME_PADDING * 2 + FRAME_COLS * FRAME_CHAR_W;
  const height = FRAME_PADDING * 2 + lines.length * FRAME_CHAR_H;
  // Scanlines carry a leading filter byte (0 = none); drawing happens on the
  // same buffer so no second pass/copy is needed.
  const stride = width + 1;
  const raw = Buffer.alloc(height * stride, BACKGROUND);
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // scanline filter

  lines.forEach((line, row) => {
    const lineTop = FRAME_PADDING + row * FRAME_CHAR_H + GLYPH_Y_OFFSET;
    for (let col = 0; col < line.length; col++) {
      const glyph = glyphFor(line.charCodeAt(col));
      const colLeft = FRAME_PADDING + col * FRAME_CHAR_W + GLYPH_X_OFFSET;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        const bits = glyph[gx];
        if (bits === 0) continue;
        const x = colLeft + gx;
        for (let gy = 0; gy < GLYPH_H; gy++) {
          if ((bits >> gy) & 1) raw[(lineTop + gy) * stride + 1 + x] = FOREGROUND;
        }
      }
    }
  });

  return encodePng(width, height, raw);
}

// ---------------------------------------------------------------------------
// PNG encoding (grayscale, 8-bit; IDAT deflate via node:zlib)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([header.subarray(4), data]), 0);
  return Buffer.concat([header, data, crc]);
}

function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // no interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
