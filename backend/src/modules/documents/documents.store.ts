// Stores a file's bytes as a new document, or as a new current version of an
// existing one. Used for results coming back from the workstation
// (goals/mission-16-documents-in-workstation.md).
//
// A trusted operation, like createDocumentVersion: the caller has already
// authorized the destination (read access to create in a project, edit access
// to version a document).

import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/db";
import { convertedPdfKey, docxToPdf } from "../../lib/convert";
import { contentTypeForDocumentType, shouldConvertToPdf } from "../../lib/documentTypes";
import { contentSha256 } from "../../lib/documentVersions";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { generatedDocKey, uploadFile, versionStorageKey } from "../../lib/storage";
import { createDocumentVersion } from "./documents.lifecycle";

export type StoredDocumentFile =
  | {
      ok: true;
      documentId: string;
      versionId: string;
      versionNumber: number;
      filename: string;
      created: boolean;
      storagePath: string;
    }
  | { ok: false; error: string };

const asArrayBuffer = (bytes: Buffer) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export async function storeDocumentFile(
  db: Db,
  params: {
    userId: string;
    bytes: Buffer;
    filename: string;
    fileType: string;
    /** For a new document: its project, or null for the library. */
    projectId: string | null;
    /** Set to add a version to this document instead of creating one. */
    documentId?: string;
  },
): Promise<StoredDocumentFile> {
  const { userId, bytes, filename, fileType } = params;
  let documentId = params.documentId;
  const created = !documentId;
  if (!documentId) {
    const { data, error } = await db
      .from("documents")
      .insert({ project_id: params.projectId, user_id: userId, status: "ready" })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: "the document could not be created" };
    documentId = (data as { id: string }).id;
  }
  const key = created
    ? generatedDocKey(userId, documentId, filename)
    : versionStorageKey(userId, documentId, randomUUID().replace(/-/g, ""), filename);
  await uploadFile(key, asArrayBuffer(bytes), contentTypeForDocumentType(fileType));

  // Word and PowerPoint get a PDF rendition, as uploads do: through the queue
  // when it is on, otherwise here (a failure leaves a usable document).
  const queued = shouldConvertToPdf(fileType) && process.env.ASYNC_DOCUMENT_CONVERSION === "true";
  let pdfStoragePath: string | null = null;
  if (shouldConvertToPdf(fileType) && !queued) {
    try {
      const pdf = await docxToPdf(bytes);
      const pdfKey = convertedPdfKey(userId, `${documentId}-${randomUUID().slice(0, 8)}`);
      await uploadFile(pdfKey, asArrayBuffer(pdf), "application/pdf");
      pdfStoragePath = pdfKey;
    } catch {
      pdfStoragePath = null;
    }
  }

  const { data: version, error } = await createDocumentVersion(db, {
    document_id: documentId,
    created_by: userId,
    storage_path: key,
    pdf_storage_path: pdfStoragePath,
    source: "generated",
    version_number: created ? 1 : null,
    filename,
    file_type: fileType,
    size_bytes: bytes.byteLength,
    page_count: null,
    content_sha256: contentSha256(bytes),
  });
  if (error || !version) return { ok: false, error: "the document version could not be recorded" };

  if (queued) {
    await enqueueConversion({
      documentId,
      versionId: version.id,
      userId,
      storagePath: key,
      fileType,
      pdfKey: convertedPdfKey(userId, documentId),
      finalizeDocumentStatus: false,
    }).catch(() => undefined);
  }
  return {
    ok: true,
    documentId,
    versionId: version.id,
    versionNumber: version.version_number,
    filename,
    created,
    storagePath: key,
  };
}
