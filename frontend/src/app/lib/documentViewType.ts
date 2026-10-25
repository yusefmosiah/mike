export type DocumentViewType = "pdf" | "docx" | "spreadsheet" | "image" | "text" | "html";

type LegacyDocViewType = Extract<DocumentViewType, "pdf" | "docx">;

export interface ResolveDocumentViewTypeOptions {
  filename?: string | null;
  fileType?: string | null;
  /** Legacy .doc files require a PDF rendition because DocxView cannot parse them. */
  legacyDocViewType?: LegacyDocViewType;
  /** Some stored Word documents have a generated PDF preview. */
  preferPdfForWord?: boolean;
}

type DocumentTypeToken =
  "pdf" | "doc" | "docx" | "spreadsheet" | "presentation" | "image" | "text" | "html" | "other";

function documentTypeToken(
  value: string | null | undefined,
): DocumentTypeToken {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "other";

  if (normalized.includes("spreadsheet") || normalized.includes("ms-excel")) {
    return "spreadsheet";
  }
  if (normalized.includes("wordprocessing") || normalized.includes("msword")) {
    return normalized.includes("openxml") ? "docx" : "doc";
  }
  if (normalized.includes("presentation")) return "presentation";
  if (normalized === "application/pdf") return "pdf";
  if (/^image\/(png|jpeg|webp|gif)$/.test(normalized)) return "image";
  if (/^text\/html(;|$)/.test(normalized)) return "html";
  if (/^text\/(plain|markdown|csv)(;|$)/.test(normalized)) return "text";

  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  // The extension, or the whole value when it has no dot.
  const token = withoutQuery.slice(withoutQuery.lastIndexOf(".") + 1);

  if (token === "xlsx" || token === "xlsm" || token === "xls") {
    return "spreadsheet";
  }
  if (token === "docx" || token === "word") return "docx";
  if (token === "doc") return "doc";
  if (token === "pptx" || token === "ppt") return "presentation";
  if (token === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(token)) return "image";
  if (token === "html") return "html";
  if (["txt", "md", "csv"].includes(token)) return "text";
  return "other";
}

/**
 * Resolve the shared viewer used for a document-like asset. Images get
 * ImageView. Unsupported and presentation formats fall back to PdfView because the backend supplies a
 * PDF rendition for those formats where required.
 */
export function resolveDocumentViewType({
  filename,
  fileType,
  legacyDocViewType = "pdf",
  preferPdfForWord = false,
}: ResolveDocumentViewTypeOptions): DocumentViewType {
  const fileTypeToken = documentTypeToken(fileType);
  const filenameToken = documentTypeToken(filename);

  if (fileTypeToken === "spreadsheet" || filenameToken === "spreadsheet") {
    return "spreadsheet";
  }
  if (fileTypeToken === "image" || filenameToken === "image") return "image";
  if (fileTypeToken === "html" || filenameToken === "html") return "html";
  if (fileTypeToken === "text" || filenameToken === "text") return "text";

  const wordToken =
    fileTypeToken === "doc" || fileTypeToken === "docx"
      ? fileTypeToken
      : filenameToken === "doc" || filenameToken === "docx"
        ? filenameToken
        : null;
  if (wordToken) {
    if (preferPdfForWord) return "pdf";
    return wordToken === "doc" ? legacyDocViewType : "docx";
  }

  return "pdf";
}

/**
 * The panel contract's name for a viewer. It has no HTML kind: a page is a
 * "text" source there, and the viewer finds the sandboxed renderer by name.
 */
export function panelTypeForViewType(
  viewType: DocumentViewType,
): Exclude<DocumentViewType, "html"> {
  return viewType === "html" ? "text" : viewType;
}
