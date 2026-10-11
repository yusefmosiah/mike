// save_to_mike: a file in the workstation becomes a Mike document, or a new
// version of one (goals/mission-16-documents-in-workstation.md). Nothing comes
// back from the VM any other way.
//
// The harness reads one regular file (no symlinks, size-capped), checks that
// its bytes are the type its name says, and checks permission now: to create
// in a project the user must be able to edit there; to version a document,
// edit access to that document. A copy in the VM never grants access.

import path from "node:path";
import type { Db } from "../../lib/db";
import { can } from "../../lib/permissions";
import { checkProjectAccess } from "../../lib/access";
import { ALLOWED_DOCUMENT_TYPES, ALLOWED_DOCUMENT_TYPES_LABEL, documentSuffix, isImageFileType } from "../../lib/documentTypes";
import { cleanImage, ImageRejectedError } from "../../lib/images";
import { decodeTextFile, isTextFileType, TextRejectedError } from "../../lib/textFiles";
import { readWorkstationFile, WORKSPACE_ROOT, type WorkstationTarget } from "../../lib/workstation";
import { ensureDocumentAccess, storeDocumentFile } from "../documents/documents.service";
import { buildWorkspaceView } from "./workspace.view";

/** The same ceiling as an upload. */
export const MAX_SAVE_BYTES = 100 * 1024 * 1024;

export type SaveToMikeInput = {
  /** The file in the workstation: absolute, or relative to /home/agent. */
  path: string;
  /** Name for the new document; default the file's own name. */
  filename?: string;
  /** A file under ~/mike whose document gets a new version instead. */
  replace?: string;
  /** For a new document: the project (default the chat's), or null for the library. */
  projectId?: string | null;
};

export type SaveToMikeResult =
  | {
      ok: true;
      documentId: string;
      versionId: string;
      versionNumber: number;
      filename: string;
      fileType: string;
      created: boolean;
      storagePath: string;
    }
  | { ok: false; error: string };

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const startsWith = (bytes: Buffer, magic: number[]) => magic.every((byte, i) => bytes[i] === byte);

/** The bytes after any cleaning, or an error when they are not what the name says. */
async function checkedBytes(bytes: Buffer, fileType: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  try {
    if (isImageFileType(fileType)) return { ok: true, bytes: Buffer.from((await cleanImage(bytes, fileType)).bytes) };
    if (isTextFileType(fileType)) {
      decodeTextFile(bytes);
      return { ok: true, bytes };
    }
  } catch (error) {
    if (error instanceof ImageRejectedError) return { ok: false, error: "the file is not an image of the type its name says" };
    if (error instanceof TextRejectedError) return { ok: false, error: "the file is not UTF-8 text" };
    throw error;
  }
  const ok =
    fileType === "pdf" ? bytes.subarray(0, 5).toString("latin1") === "%PDF-"
    : ["docx", "xlsx", "xlsm", "pptx"].includes(fileType) ? startsWith(bytes, ZIP)
    : ["doc", "xls", "ppt"].includes(fileType) ? startsWith(bytes, OLE)
    : false;
  return ok ? { ok: true, bytes } : { ok: false, error: `the file is not a ${fileType} file` };
}

/** "projects/A/x.docx" from "/home/agent/mike/projects/A/x.docx", "~/mike/...", or "mike/...". */
export function workspaceRelative(target: string): string | null {
  const home = path.posix.dirname(WORKSPACE_ROOT);
  let full = target.trim().replace(/^~(?=\/|$)/, home);
  if (!full.startsWith("/")) full = path.posix.join(home, full);
  full = path.posix.normalize(full);
  if (!full.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  return full.slice(WORKSPACE_ROOT.length + 1);
}

export async function saveToMike(
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  input: SaveToMikeInput,
  deps: { readFile?: typeof readWorkstationFile; buildView?: typeof buildWorkspaceView } = {},
): Promise<SaveToMikeResult> {
  const readFile = deps.readFile ?? readWorkstationFile;
  const buildView = deps.buildView ?? buildWorkspaceView;
  const filename = (input.filename?.trim() || path.posix.basename(input.path.trim())).slice(0, 255);
  const fileType = documentSuffix(filename);
  if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
    return { ok: false, error: `Documents can be ${ALLOWED_DOCUMENT_TYPES_LABEL}; "${filename}" is not one of them.` };
  }

  // Authorize before reading anything out of the VM.
  let documentId: string | undefined;
  if (input.replace) {
    const relative = workspaceRelative(input.replace);
    const file = relative ? (await buildView(db, user)).get(relative) : undefined;
    if (!file) return { ok: false, error: "replace must name a document under ~/mike that you can still read." };
    const access = await ensureDocumentAccess(file.documentId, user.id, user.email ?? undefined, db);
    if (!access.ok || !can(access.projectRole, "content.edit")) {
      return { ok: false, error: "You cannot edit that document." };
    }
    documentId = file.documentId;
  } else if (input.projectId) {
    const access = await checkProjectAccess(input.projectId, user.id, user.email, db);
    if (!access.ok || !can(access.projectRole, "content.edit")) {
      return { ok: false, error: "You cannot add documents to that project." };
    }
  }

  const read = await readFile(target, input.path, MAX_SAVE_BYTES);
  if (!read.ok) return { ok: false, error: `Could not read ${input.path}: ${read.error}.` };
  const checked = await checkedBytes(read.bytes, fileType);
  if (!checked.ok) return { ok: false, error: `${filename}: ${checked.error}.` };

  const stored = await storeDocumentFile(db, {
    userId: user.id,
    bytes: checked.bytes,
    filename,
    fileType,
    projectId: input.projectId ?? null,
    documentId,
  });
  return stored.ok ? { ...stored, fileType } : stored;
}
