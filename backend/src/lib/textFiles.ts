// Plain-text documents: .txt, .md, .csv and .html (docs/reports/file-intake-2026-10-10.md,
// phase I2). They are stored as uploaded, after one check that they are text:
// valid UTF-8 with no NUL bytes. A binary file renamed .txt is refused.

export const TEXT_FILE_TYPES = ["txt", "md", "csv", "html"] as const;

const TEXT_TYPES = new Set<string>(TEXT_FILE_TYPES);

export function isTextFileType(fileType: string | null | undefined): boolean {
  return TEXT_TYPES.has((fileType ?? "").toLowerCase());
}

export class TextRejectedError extends Error {
  readonly code = "unsupported_text";
  constructor() {
    super("The file is not UTF-8 text.");
    this.name = "TextRejectedError";
  }
}

/** The file's text, or TextRejectedError when it is not UTF-8 text. */
export function decodeTextFile(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new TextRejectedError();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TextRejectedError();
  }
}

/**
 * Text as a model should see it: no byte-order mark, \n line endings, and
 * without Unicode tag characters (U+E0000–U+E007F), which render as nothing
 * and are a known way to hide instructions in text.
 */
export function textForModel(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u{E0000}-\u{E007F}]/gu, "");
}
