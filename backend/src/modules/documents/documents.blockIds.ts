// Block ids for .docx versions.
//
// The assistant reads and edits a Word document by block ids. A version
// stores its ids (document_versions.block_ids, with the hash of the bytes
// they describe), and a version without valid ids inherits them from the
// version before it, so an id a reader already has keeps naming the same
// paragraph across edits, accept/reject, and new uploads.

import { blockIds, carryBlockIds } from "../../lib/docx/blockIds";
import { DocxDocument } from "../../lib/docx/view";
import { contentSha256 } from "../../lib/documentVersions";
import { downloadFile } from "../../lib/storage";
import { devLog } from "../../lib/log";
import type { Db } from "./documents.shared";

export interface StoredBlockIds {
  sha256: string;
  ids: string[];
}

function parseStored(value: unknown): StoredBlockIds | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { sha256?: unknown; ids?: unknown };
  if (typeof v.sha256 !== "string" || !Array.isArray(v.ids) || !v.ids.every((id) => typeof id === "string")) return null;
  return { sha256: v.sha256, ids: v.ids as string[] };
}

/** The block-id record for these bytes. */
export function blockIdsRecord(bytes: Buffer, ids: string[]): StoredBlockIds {
  return { sha256: contentSha256(bytes), ids };
}

/**
 * The document view of a version's bytes, labelled with the version's
 * block ids. Ids missing or stale (the bytes changed without them) are
 * derived from the previous version and stored.
 */
export async function docxViewForVersion(db: Db, documentId: string, versionId: string, bytes: Buffer): Promise<DocxDocument> {
  const doc = await DocxDocument.load(bytes);
  const { data: row } = await db
    .from("document_versions")
    .select("id, version_number, block_ids")
    .eq("id", versionId)
    .eq("document_id", documentId)
    .maybeSingle();
  if (!row) return doc;
  const stored = parseStored(row.block_ids);
  if (stored && stored.sha256 === contentSha256(bytes) && doc.relabel(stored.ids)) return doc;
  const prev = await previousVersionView(db, documentId, row.version_number as number | null);
  if (prev) doc.relabel(carryBlockIds(prev, doc));
  await saveBlockIds(db, documentId, versionId, bytes, blockIds(doc));
  return doc;
}

/** The previous version's view with its ids, when it is a readable .docx. */
async function previousVersionView(db: Db, documentId: string, versionNumber: number | null): Promise<DocxDocument | null> {
  if (versionNumber === null || versionNumber === undefined) return null;
  const { data: prev } = await db
    .from("document_versions")
    .select("storage_path, block_ids")
    .eq("document_id", documentId)
    .lt("version_number", versionNumber)
    .is("deleted_at", null)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!prev?.storage_path) return null;
  const raw = await downloadFile(prev.storage_path as string);
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw);
    const doc = await DocxDocument.load(bytes);
    const stored = parseStored(prev.block_ids);
    if (stored && stored.sha256 === contentSha256(bytes)) doc.relabel(stored.ids);
    return doc;
  } catch {
    return null; // not a .docx (a PDF version, say): no ids to inherit
  }
}

/** Store a version's block ids for its current bytes. Best effort: ids are re-derived if this fails. */
export async function saveBlockIds(db: Db, documentId: string, versionId: string, bytes: Buffer, ids: string[]): Promise<void> {
  const { error } = await db
    .from("document_versions")
    .update({ block_ids: blockIdsRecord(bytes, ids) })
    .eq("id", versionId)
    .eq("document_id", documentId)
    .is("deleted_at", null);
  if (error) devLog(`[block-ids] could not store ids for version ${versionId}`);
}
