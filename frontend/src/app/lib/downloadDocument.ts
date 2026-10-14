import { getDocumentFile } from "./mikeApi";
import { saveFileNatively } from "./nativeFiles";

/**
 * Download bytes with consistent filename handling and object-URL cleanup.
 * Inside the iPhone app, whose web view ignores blob downloads, the file goes
 * to the share sheet instead.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
    if (await saveFileNatively(blob, filename)) return;
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export async function downloadDocumentFile(documentId: string, versionId?: string | null, filename = "document") {
    const file = await getDocumentFile(documentId, versionId);
    await downloadBlob(file.blob, file.filename || filename);
}
