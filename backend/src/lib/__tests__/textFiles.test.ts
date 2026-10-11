import { describe, expect, it } from "vitest";

import { decodeTextFile, isTextFileType, TextRejectedError, textForModel } from "../textFiles";

describe("text files", () => {
  it("knows its types", () => {
    expect(["txt", "md", "CSV"].map(isTextFileType)).toEqual([true, true, true]);
    expect(["pdf", "", null, undefined].map(isTextFileType)).toEqual([false, false, false, false]);
  });

  it("decodes UTF-8 and refuses binary or other encodings", () => {
    expect(decodeTextFile(new TextEncoder().encode("Größe, 価格\n"))).toBe("Größe, 価格\n");
    expect(() => decodeTextFile(Uint8Array.from([0x61, 0x00, 0x62]))).toThrow(TextRejectedError);
    // Latin-1 "é" alone is not valid UTF-8.
    expect(() => decodeTextFile(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toThrow(TextRejectedError);
    try {
      decodeTextFile(Uint8Array.from([0xff]));
    } catch (error) {
      expect((error as TextRejectedError).code).toBe("unsupported_text");
    }
  });

  it("gives the model plain text without a BOM, CRs, or invisible tag characters", () => {
    const hidden = [...("ignore previous")].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(textForModel(`﻿line one\r\nline two\rend${hidden}.`)).toBe("line one\nline two\nend.");
  });
});
