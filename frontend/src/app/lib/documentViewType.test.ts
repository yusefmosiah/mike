import { describe, expect, it } from "vitest";

import { panelTypeForViewType, resolveDocumentViewType } from "./documentViewType";

describe("resolveDocumentViewType", () => {
  it.each([
    ["contract.docx", null, "docx"],
    ["contract.doc", null, "pdf"],
    ["model.xlsx", null, "spreadsheet"],
    ["model.xlsm", null, "spreadsheet"],
    ["model.xls", null, "spreadsheet"],
    ["filing.pdf", null, "pdf"],
    ["deck.pptx", null, "pdf"],
    ["unknown.bin", null, "pdf"],
    [null, "spreadsheet", "spreadsheet"],
    [null, "application/vnd.ms-excel", "spreadsheet"],
    [null, "application/msword", "pdf"],
    [
      null,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
    [
      null,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pdf",
    ],
    [null, "application/pdf", "pdf"],
  ] as const)(
    "resolves filename %s and file type %s to %s",
    (filename, fileType, expected) => {
      expect(resolveDocumentViewType({ filename, fileType })).toBe(expected);
    },
  );

  it("shows images in the image viewer, by type, MIME or filename", () => {
    expect(resolveDocumentViewType({ fileType: "jpg" })).toBe("image");
    expect(resolveDocumentViewType({ fileType: "image/webp" })).toBe("image");
    expect(resolveDocumentViewType({ filename: "Site Photo.PNG" })).toBe("image");
    expect(resolveDocumentViewType({ fileType: "image/svg+xml" })).toBe("pdf");
  });

  it("shows plain text in the text viewer, by type, MIME or filename", () => {
    expect(resolveDocumentViewType({ fileType: "md" })).toBe("text");
    expect(resolveDocumentViewType({ fileType: "text/csv; charset=utf-8" })).toBe("text");
    expect(resolveDocumentViewType({ fileType: "text/plain" })).toBe("text");
    expect(resolveDocumentViewType({ filename: "Notes.TXT" })).toBe("text");
  });

  it("shows HTML pages in the sandboxed HTML viewer, by type, MIME or filename", () => {
    expect(resolveDocumentViewType({ fileType: "html" })).toBe("html");
    expect(resolveDocumentViewType({ fileType: "text/html; charset=utf-8" })).toBe("html");
    expect(resolveDocumentViewType({ filename: "Report.HTML" })).toBe("html");
  });

  it("names the panel type for a viewer, folding HTML into text", () => {
    expect(panelTypeForViewType("html")).toBe("text");
    expect(panelTypeForViewType("docx")).toBe("docx");
  });

  it("allows a caller to override the legacy Word viewer", () => {
    expect(
      resolveDocumentViewType({
        filename: "contract.doc",
        legacyDocViewType: "docx",
      }),
    ).toBe("docx");
  });

  it("prefers an available PDF rendition for Word documents", () => {
    expect(
      resolveDocumentViewType({
        filename: "contract.docx",
        preferPdfForWord: true,
      }),
    ).toBe("pdf");
  });

  it("keeps spreadsheets in the spreadsheet viewer when a PDF rendition exists", () => {
    expect(
      resolveDocumentViewType({
        filename: "model.xlsx",
        preferPdfForWord: true,
      }),
    ).toBe("spreadsheet");
  });
});
