import type { Message } from "@/app/components/shared/types";

/** A document this chat created, edited, copied or showed, as the side panel opens it. */
export interface ChatPanelDocument {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
}

/**
 * The documents the assistant created, edited, copied or showed inline in
 * this chat, oldest first, so the last entry is the most recent. A document
 * touched more than once appears once, at its latest position and version.
 * Events still streaming or that failed are skipped.
 */
export function chatPanelDocuments(messages: readonly Message[]): ChatPanelDocument[] {
    const byId = new Map<string, ChatPanelDocument>();
    const add = (document: ChatPanelDocument) => {
        byId.delete(document.documentId);
        byId.set(document.documentId, document);
    };
    for (const message of messages) {
        for (const event of message.events ?? []) {
            if (event.type === "doc_created" || event.type === "doc_edited") {
                if (event.isStreaming || !event.document_id) continue;
                if (event.type === "doc_edited" && event.error) continue;
                add({
                    documentId: event.document_id,
                    filename: event.filename,
                    versionId: event.version_id || null,
                    versionNumber: event.version_number ?? null,
                });
            } else if (event.type === "media") {
                if (!event.document_id) continue;
                add({
                    documentId: event.document_id,
                    filename: event.filename,
                    versionId: event.version_id ?? null,
                    versionNumber: event.version_number ?? null,
                });
            } else if (event.type === "doc_replicated") {
                if (event.isStreaming || event.error) continue;
                for (const copy of event.copies ?? []) {
                    add({
                        documentId: copy.document_id,
                        filename: copy.new_filename,
                        versionId: copy.version_id,
                        versionNumber: 1,
                    });
                }
            }
        }
    }
    return [...byId.values()];
}
