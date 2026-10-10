// The common reading model (goals/mission-14-document-model.md).
export type { DocBlock, DocBlockKind, DocFormat, DocumentModel } from "./types";
export { docxToModel } from "./fromDocx";
export { markdownToModel, textToModel } from "./fromMarkdown";
export { pdfToModel } from "./fromPdf";
export { spreadsheetToModel } from "./fromSpreadsheet";
export { presentationToModel } from "./fromPresentation";

import type { DocumentModel } from "./types";

const CACHE_LIMIT = 64;
const cache = new Map<string, DocumentModel>();

/**
 * Models are pure functions of a version's bytes, so the last few are kept
 * by version id (or storage path for a document without versions).
 */
export async function cachedModel(key: string | null, build: () => Promise<DocumentModel>): Promise<DocumentModel> {
    if (key) {
        const hit = cache.get(key);
        if (hit) {
            cache.delete(key);
            cache.set(key, hit);
            return hit;
        }
    }
    const model = await build();
    if (key) {
        cache.set(key, model);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    }
    return model;
}

/** Characters of text a model holds, for the map the prompt shows. */
export function modelChars(model: DocumentModel): number {
    return model.blocks.reduce((sum, block) => sum + block.text.length, 0);
}
