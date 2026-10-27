// The whole readable text of a document version, through the shared document
// model. Backs GET /:documentId/text so the viewer's Copy action can put
// content on the clipboard for any format, not only the format the mounted
// editor knows.

import { ensureDocumentAccess } from "./documents.access";
import type { Db } from "./documents.shared";
import { loadActiveVersion } from "../../lib/documentVersions";
import { downloadFile } from "../../lib/storage";
import { isImageFileType, isMediaFileType, isSpreadsheetDocumentType } from "../../lib/documentTypes";
import { isTextFileType, textForModel } from "../../lib/textFiles";
import { docxToPdf } from "../../lib/convert";
import { extractPdfPages } from "../../lib/pdfText";
import { DocxDocument } from "../../lib/docx/view";
import {
    cachedModel,
    docxToModel,
    markdownToModel,
    pdfToModel,
    presentationToModel,
    spreadsheetToModel,
    textToModel,
    type DocumentModel,
} from "../../lib/documentModel";
import { devLog } from "../../lib/log";
import {
    internalFailure,
    ok,
    failure,
    type ServiceResult,
} from "../../lib/serviceResult";

/** One model as paste-ready text: blocks blank-line separated, tables as TSV. */
export function modelToText(model: DocumentModel): string {
    return model.blocks
        .map((block) =>
            block.rows?.length
                ? block.rows.map((row) => row.join("\t")).join("\n")
                : block.text,
        )
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n\n");
}

export type DocumentText = {
    text: string;
    chars: number;
    format: DocumentModel["format"];
};

/**
 * Read a version's bytes and flatten them to text through the shared model.
 * Docx keeps its block-id wiring (`docxViewForVersion` relabels as a side
 * effect the copy path does not need); every other format matches the tool
 * dispatch in documentOps.documentModelFor.
 */
export async function getDocumentText(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
): Promise<ServiceResult<DocumentText>> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Document not found");

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active) return failure("not_found", "No file available");

    const fileType = active.file_type?.toLowerCase() ?? "";
    if (isImageFileType(fileType) || isMediaFileType(fileType)) {
        return failure("validation", "This document has no text content");
    }

    try {
        const model = await cachedModel(`copy:${active.id}`, async () => {
            const raw = await downloadFile(active.storage_path);
            if (!raw) throw new Error("no bytes");
            const bytes = Buffer.from(raw);
            if (fileType === "docx") return docxToModel(await DocxDocument.load(bytes));
            if (fileType === "pdf") return pdfToModel(await extractPdfPages(raw));
            if (isSpreadsheetDocumentType(fileType) || fileType === "csv") return spreadsheetToModel(bytes);
            if (fileType === "pptx") return presentationToModel(bytes);
            if (fileType === "md" || fileType === "markdown")
                return markdownToModel(textForModel(bytes.toString("utf8")));
            if (isTextFileType(fileType)) return textToModel(textForModel(bytes.toString("utf8")));
            // Legacy Office (.doc, .ppt) and anything else with no direct
            // reader: through the PDF rendition, as reads do.
            const pdf = await docxToPdf(bytes);
            return pdfToModel(await extractPdfPages(
                pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer,
            ));
        });
        const text = modelToText(model);
        return ok({ text, chars: text.length, format: model.format });
    } catch (error) {
        devLog(`[documents.text] could not read ${active.filename ?? documentId} as text`, error);
        return internalFailure(error);
    }
}
