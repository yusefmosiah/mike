import path from "path";

export const STANDARD_FONT_DATA_URL = (() => {
  try {
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

import { docxToPdf } from "./convert";
import { logError } from "./log";
import { orderTextItemLines } from "./pdfTextOrder";
import type { Canvas } from "@napi-rs/canvas";

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfFormAnnotation = {
  fieldName?: unknown;
  fieldValue?: unknown;
  password?: boolean;
  fieldFlags?: unknown;
  radioButton?: boolean;
  buttonValue?: unknown;
  rect?: unknown;
};

type ExtractedFormField = {
  text: string;
  rect: [number, number, number, number] | null;
};

type PdfViewport = { width: number; height: number };

type PdfRenderTask = { promise: Promise<void> };

type PdfPage = {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  getAnnotations: () => Promise<PdfFormAnnotation[]>;
  getOperatorList: () => Promise<{ fnArray: number[] }>;
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (params: {
    canvasContext: unknown;
    viewport: PdfViewport;
  }) => PdfRenderTask;
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfJsLib = {
  getDocument: (options: unknown) => { promise: Promise<PdfDocument> };
  /** Operator codes for the content-stream ops; absent means "cannot inspect". */
  OPS?: Record<string, number>;
};

/** Canvas surface used to rasterise a page; the backend loads lazily. */
type CanvasModule = {
  createCanvas: (width: number, height: number) => Canvas;
};

// PDF field flags are one-based in the specification; bit 14 marks a text
// field whose value must not be exposed as ordinary document text.
const PDF_FIELD_FLAG_PASSWORD = 1 << 13;

function formValueText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.replaceAll(/\s+/g, " ").trim();
    return text || null;
  }
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  ) {
    const entries = value
      .map((entry) => entry.replaceAll(/\s+/g, " ").trim())
      .filter(Boolean);
    return entries.length ? entries.join(", ") : null;
  }
  return null;
}

function formFieldRect(rect: unknown): [number, number, number, number] | null {
  if (
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }
  const [rawX1, rawY1, rawX2, rawY2] = rect as number[];
  const x1 = Math.min(rawX1, rawX2);
  const y1 = Math.min(rawY1, rawY2);
  const x2 = Math.max(rawX1, rawX2);
  const y2 = Math.max(rawY1, rawY2);
  return x1 === x2 || y1 === y2 ? null : [x1, y1, x2, y2];
}

function extractFormFields(
  annotations: PdfFormAnnotation[],
): ExtractedFormField[] {
  const fields: ExtractedFormField[] = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    const fieldName =
      typeof annotation.fieldName === "string"
        ? annotation.fieldName.trim()
        : "";
    const isPassword =
      annotation.password === true ||
      (typeof annotation.fieldFlags === "number" &&
        (annotation.fieldFlags & PDF_FIELD_FLAG_PASSWORD) !== 0);
    if (!fieldName || isPassword) continue;

    // Every widget in a radio group carries the group's selected fieldValue.
    // Only the widget representing that selected value should be emitted.
    if (
      annotation.radioButton === true &&
      (typeof annotation.fieldValue !== "string" ||
        annotation.buttonValue !== annotation.fieldValue)
    ) {
      continue;
    }

    const fieldValue = formValueText(annotation.fieldValue);
    if (fieldValue === null) continue;

    const key = JSON.stringify([fieldName, fieldValue]);
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({
      text: `${fieldName}: ${fieldValue}`,
      rect: formFieldRect(annotation.rect),
    });
  }

  return fields;
}

function positionedFormItem(field: ExtractedFormField): PdfTextItem | null {
  if (!field.rect) return null;
  const [x1, y1, x2, y2] = field.rect;
  const height = Math.max(8, Math.min(16, (y2 - y1) * 0.7));
  const text = `[${field.text}]`;
  return {
    str: text,
    transform: [1, 0, 0, height, x1, (y1 + y2) / 2],
    width: text.length * height * 0.5,
    height,
  };
}

/**
 * Rebuild a page's text from positioned pdfjs items, preserving the visual
 * layout: lines are reconstructed from y-coordinates, words
 * are joined (or split) based on measured x-gaps rather than a blanket
 * space, paragraph breaks become blank lines, and indentation is kept
 * relative to the page's left margin.
 */
function layoutPageText(items: PdfTextItem[]): string {
  type Item = {
    str: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const clean: Item[] = [];
  for (const it of items) {
    const str = it.str ?? "";
    if (!str) continue;
    const t = Array.isArray(it.transform) ? it.transform : [];
    clean.push({
      str,
      x: typeof t[4] === "number" ? t[4] : 0,
      y: typeof t[5] === "number" ? t[5] : 0,
      w: typeof it.width === "number" ? it.width : 0,
      h:
        Math.abs(typeof t[3] === "number" ? t[3] : 0) ||
        (typeof it.height === "number" ? it.height : 0) ||
        10,
    });
  }
  if (!clean.length) return "";

  const lines: Item[][] = orderTextItemLines(clean).map((line) =>
    line.map((index) => clean[index]),
  );

  const marginX = Math.min(...lines.map((line) => line[0]?.x ?? 0));

  const out: string[] = [];
  let prevY: number | null = null;
  let prevLineH: number | null = null;
  for (const line of lines) {
    const lineH = Math.max(...line.map((c) => c.h));

    // Paragraph break: a vertical gap well above the line height.
    if (prevY !== null && prevLineH !== null) {
      const vGap = Math.abs((line[0]?.y ?? 0) - prevY);
      if (vGap > prevLineH * 1.7) out.push("");
    }

    // Indentation relative to the page's left margin.
    const charW = Math.max(1, lineH * 0.5);
    const indent = Math.min(
      24,
      Math.max(0, Math.round(((line[0]?.x ?? 0) - marginX) / charW)),
    );

    let s = "";
    let prevEnd: number | null = null;
    for (const it of line) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        // Only insert a space for a real word gap — small kerning gaps
        // (e.g. "constitut" + "e") are joined without one.
        if (gap > lineH * 2.5) {
          // Preserve obvious columns (signature blocks and simple tables)
          // without exaggerating ordinary word spacing in justified text.
          s += " ".repeat(Math.min(16, Math.max(4, Math.round(gap / charW))));
        } else if (gap > lineH * 0.15) {
          // Common spaces are about 0.25em; leave room below that while
          // keeping zero/tiny kerning gaps joined.
          s += " ";
        }
      }
      s += it.str;
      prevEnd = it.x + it.w;
    }
    const trimmed = s.trimEnd();
    if (trimmed) out.push(" ".repeat(indent) + trimmed);
    prevY = line[0]?.y ?? prevY;
    prevLineH = lineH;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Scanned pages
//
// A scanned page has no text layer, so pdfjs returns nothing for it and every
// consumer of the extracted text (chat answers, citations, diligence) treats
// the page as empty — with no way to tell "this page is blank" from "this page
// was never read". Detection below is deliberately conservative — almost no
// text AND the content stream actually paints an image — and the outcome is
// always visible in the output: recovered text is marked `[Page N — OCR]`,
// anything that cannot be recovered keeps the page and says so
// (`— scanned image, OCR pending`), never a silent empty page.
// ---------------------------------------------------------------------------

/** The scan check counts a page's non-whitespace characters against this. */
const SCANNED_PAGE_MAX_TEXT_CHARS = 20;

/** Rasterisation scale for OCR (~2x, i.e. ~150 dpi for a 72 dpi page). */
const OCR_RENDER_SCALE = 2;

/** Cap on rasterised page area: an oversized sheet must not allocate a huge canvas. */
const OCR_MAX_PAGE_PIXELS = 12_000_000;

/** Scanned pages OCR'd per extraction; any further ones keep the pending marker. */
const OCR_MAX_PAGES_PER_DOCUMENT = 10;

/** A page's OCR must settle within this, or the OCR worker is dropped. */
const OCR_PAGE_TIMEOUT_MS = 30_000;

/** Vendored tesseract language data (see assets/tessdata/eng.traineddata.gz). */
const OCR_LANG_DATA_DIR = path.join(
  __dirname,
  "..",
  "..",
  "assets",
  "tessdata",
);

/** Marker suffix on a page whose text was recovered by OCR. */
const OCR_PAGE_MARKER = " — OCR";

/** Marker suffix on a scanned page whose text could not be recovered. */
const OCR_PENDING_MARKER = " — scanned image, OCR pending";

/**
 * Whether extracted text still contains a page whose scanned content could not
 * be read. Callers use it to tell "the whole document was read" from "some
 * pages are unreadable as text" — the document.precompute_text job records it
 * as an `ocr_pending` note on the job row.
 */
export function needsOcr(text: string): boolean {
  return text.includes(OCR_PENDING_MARKER);
}

/**
 * Content-stream ops that paint a raster image. `paintSolidColorImageMask` is
 * excluded on purpose: it is a vector-ish fill, not a scan.
 */
const IMAGE_PAINT_OPS = [
  "paintImageXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObject",
  "paintImageMaskXObjectRepeat",
  "paintImageMaskXObjectGroup",
] as const;

/**
 * Whether the page draws a raster image. Only called for pages that already
 * failed the text check, so the operator-list pass stays off the common path;
 * a page whose ops cannot be read is not claimed to be a scan.
 */
async function pageDrawsImage(
  page: PdfPage,
  ops: Record<string, number> | undefined,
): Promise<boolean> {
  const imageOps = IMAGE_PAINT_OPS.map((name) => ops?.[name]).filter(
    (op): op is number => typeof op === "number",
  );
  if (!imageOps.length) return false;
  try {
    const { fnArray } = await page.getOperatorList();
    return fnArray.some((op) => imageOps.includes(op));
  } catch {
    return false;
  }
}

let canvasModulePromise: Promise<CanvasModule | null> | null = null;

/**
 * Load the canvas backend pdfjs already renders through in Node
 * (`@napi-rs/canvas`, its own NodeCanvasFactory dependency). The result is
 * cached — including a failure: retrying a missing native module on every
 * scanned page would only add latency, and the pages fall back to the
 * OCR-pending marker either way.
 */
function loadCanvasModule(): Promise<CanvasModule | null> {
  canvasModulePromise ??= (async () => {
    try {
      // Platform-specific native addon: a static import would break every
      // text-extraction caller on a host where pdfjs' optional canvas backend
      // is not installed, which is exactly what the pending marker is for.
      const canvas: CanvasModule = await import("@napi-rs/canvas");
      return canvas;
    } catch (error) {
      logError("pdfText.canvas", error);
      return null;
    }
  })();
  return canvasModulePromise;
}

/** Minimal shape of the tesseract.js worker this module drives. */
type OcrWorker = {
  recognize: (image: Uint8Array) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

type OcrWorkerHandle = {
  worker: OcrWorker;
  /** One recognition at a time: a tesseract worker handles a single job. */
  queue: Promise<unknown>;
};

let ocrWorker: Promise<OcrWorkerHandle | null> | null = null;

async function createOcrWorker(): Promise<OcrWorkerHandle | null> {
  try {
    // Dynamic on purpose: tesseract.js carries the wasm OCR core, and a static
    // import would also make a broken OCR install break every extraction path
    // including the ones that never meet a scanned page.
    const tesseract = (await import("tesseract.js")) as unknown as {
      createWorker: (
        langs: string,
        oem: undefined,
        options: Record<string, unknown>,
      ) => Promise<OcrWorker>;
    };
    const worker = await tesseract.createWorker(
      "eng",
      undefined, // default engine (LSTM only)
      {
        // The traineddata ships with the repo: OCR must never depend on — or
        // contact — a CDN, and "none" stops tesseract.js caching data of its own.
        langPath: OCR_LANG_DATA_DIR,
        cacheMethod: "none",
      },
    );
    return { worker, queue: Promise.resolve() };
  } catch (error) {
    logError("pdfText.ocr", error);
    return null;
  }
}

/**
 * Run `task` on the worker after any recognition already queued for it. The
 * queue belongs to one worker: a worker dropped after a timeout must not block
 * recognitions handed to its replacement.
 */
function runOnWorker<T>(
  handle: OcrWorkerHandle,
  task: () => Promise<T>,
): Promise<T> {
  const run = handle.queue.then(task, task);
  handle.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type DeadlineResult<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean };

/** Resolve when `work` settles or `ms` elapses, never rejecting. */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<DeadlineResult<T>> {
  let settle: (result: DeadlineResult<T>) => void = () => undefined;
  const promise = new Promise<DeadlineResult<T>>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle({ ok: false, timedOut: true }), ms);
  work.then(
    (value) => {
      clearTimeout(timer);
      settle({ ok: true, value });
    },
    () => {
      clearTimeout(timer);
      settle({ ok: false, timedOut: false });
    },
  );
  return promise;
}

/**
 * Rasterise one page to a PNG for OCR. The scale is capped so an oversized
 * sheet cannot allocate an unbounded canvas; the cap only ever lowers the
 * resolution, it never changes which pages are OCR'd.
 */
async function rasterizePage(page: PdfPage): Promise<Uint8Array | null> {
  const canvasModule = await loadCanvasModule();
  if (!canvasModule) return null;
  const baseViewport = page.getViewport({ scale: 1 });
  const basePixels =
    Math.max(1, baseViewport.width) * Math.max(1, baseViewport.height);
  const scale = Math.min(
    OCR_RENDER_SCALE,
    Math.sqrt(OCR_MAX_PAGE_PIXELS / basePixels),
  );
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const viewport = page.getViewport({ scale });
  const canvas = canvasModule.createCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  );
  await page.render({ canvasContext: canvas.getContext("2d"), viewport })
    .promise;
  return canvas.toBuffer("image/png");
}

/** Per-extraction OCR state (the worker itself outlives the extraction). */
type OcrRun = {
  /** Scanned pages handed to OCR so far, bounded by the per-document budget. */
  used: number;
  /** Set once OCR is no longer worth attempting for the rest of this document. */
  suspended: boolean;
};

/**
 * OCR one page, or return null when its text could not be recovered (no
 * worker, no canvas, render failure, OCR failure, timeout). Never throws: a
 * page that cannot be read must degrade to the pending marker, not lose the
 * rest of the document.
 */
async function ocrPage(page: PdfPage, run: OcrRun): Promise<string | null> {
  if (run.suspended || run.used >= OCR_MAX_PAGES_PER_DOCUMENT) return null;
  try {
    ocrWorker ??= createOcrWorker();
    const handle = await ocrWorker;
    if (!handle) return null;
    const image = await rasterizePage(page);
    if (!image) return null;
    run.used += 1;
    const result = await withDeadline(
      runOnWorker(handle, () => handle.worker.recognize(image)),
      OCR_PAGE_TIMEOUT_MS,
    );
    if (!result.ok) {
      if (result.timedOut) {
        // Whatever wedged this page would wedge the next one: drop the worker
        // so the next document starts clean, and stop paying the timeout for
        // every remaining scanned page of this one.
        run.suspended = true;
        ocrWorker = null;
        void handle.worker.terminate().catch(() => {});
        logError(
          "pdfText.ocr",
          new Error(`OCR timed out after ${OCR_PAGE_TIMEOUT_MS}ms`),
        );
      }
      return null;
    }
    return result.value.data.text.trim() || null;
  } catch (error) {
    logError("pdfText.ocr", error);
    return null;
  }
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = (await import(
      "pdfjs-dist/legacy/build/pdf.mjs" as string
    )) as unknown as PdfJsLib;
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const ocrRun: OcrRun = { used: 0, suspended: false };
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      let fields: ExtractedFormField[] = [];
      try {
        fields = extractFormFields(await page.getAnnotations());
      } catch {
        // Keep the page's content-stream text if its annotations are malformed.
      }
      const positionedFields = fields
        .map(positionedFormItem)
        .filter((item): item is PdfTextItem => item !== null);
      const extracted = layoutPageText([
        ...textContent.items,
        ...positionedFields,
      ]);
      let marker = "";
      let body = extracted;
      if (
        extracted.replaceAll(/\s+/g, "").length <
          SCANNED_PAGE_MAX_TEXT_CHARS &&
        (await pageDrawsImage(page, pdfjsLib.OPS))
      ) {
        const ocrText = await ocrPage(page, ocrRun);
        if (ocrText) {
          marker = OCR_PAGE_MARKER;
          // Whatever small text layer the page did have stays: it is real
          // content the OCR pass may read differently (or miss entirely).
          body = extracted.trim() ? `${ocrText}\n${extracted}` : ocrText;
        } else {
          marker = OCR_PENDING_MARKER;
        }
      }
      let pageText = `[Page ${i}${marker}]\n${body}`;
      const unpositionedFields = fields.filter((field) => !field.rect);
      if (unpositionedFields.length) {
        pageText += `\n[Page ${i} form fields]\n${unpositionedFields
          .map((field) => field.text)
          .join("\n")}`;
      }
      parts.push(pageText);
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The text read_document derives for the legacy Office types (.doc/.ppt):
 * LibreOffice → PDF → pdfjs. Exported so the document.precompute_text job
 * produces byte-identical text to the inline read path — a cache that can
 * drift from what it caches is worse than no cache.
 */
export async function extractLegacyOfficeText(
  raw: ArrayBuffer,
): Promise<string> {
  const pdfBuf = await docxToPdf(Buffer.from(raw));
  return extractPdfText(
    pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer,
  );
}
