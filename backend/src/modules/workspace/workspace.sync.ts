// Brings ~/mike in a user's workstation up to date with what they can read in
// Mike (goals/mission-16-documents-in-workstation.md, phase 1: a copy). Only
// changes travel: new and changed files are written, and files the user can
// no longer read, or that were deleted, are removed.

import type { Db } from "../../lib/db";
import { downloadFile } from "../../lib/storage";
import {
  readWorkspaceManifest,
  writeWorkspaceBatch,
  type ManifestEntry,
  type WorkstationTarget,
} from "../../lib/workstation";
import { buildWorkspaceView, type WorkspaceView } from "./workspace.view";

/** Bytes per ssh session; a big first sync is several sessions. */
const BATCH_BYTES = 64 * 1024 * 1024;

export type WorkspaceSyncResult =
  | { ok: true; files: number; written: number; deleted: number; skipped: number; view: WorkspaceView }
  | { ok: false; error: string };

export type SyncDeps = {
  buildView?: typeof buildWorkspaceView;
  readManifest?: typeof readWorkspaceManifest;
  writeBatch?: typeof writeWorkspaceBatch;
  download?: (storagePath: string) => Promise<ArrayBuffer | null>;
};

export async function syncWorkspace(
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  deps: SyncDeps = {},
): Promise<WorkspaceSyncResult> {
  const buildView = deps.buildView ?? buildWorkspaceView;
  const readManifest = deps.readManifest ?? readWorkspaceManifest;
  const writeBatch = deps.writeBatch ?? writeWorkspaceBatch;
  const download = deps.download ?? downloadFile;

  const view = await buildView(db, user);
  const present = await readManifest(target);
  if (!present.ok) return present;

  // What the VM will hold afterwards: what it has that is still current,
  // plus what this sync writes.
  const manifest: Record<string, ManifestEntry> = {};
  const toWrite: string[] = [];
  for (const [path, file] of view) {
    const there = present.files[path];
    if (there && there.version === file.versionId) manifest[path] = there;
    else toWrite.push(path);
  }
  const toDelete = Object.keys(present.files).filter((path) => !view.has(path) || !manifest[path]);

  let written = 0;
  let skipped = 0;
  let batch: { path: string; bytes: Buffer }[] = [];
  let batchBytes = 0;
  let deletes = toDelete;
  const flush = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!batch.length && !deletes.length) return { ok: true };
    const result = await writeBatch(target, { delete: deletes, files: batch, manifest: { ...manifest } });
    if (!result.ok) return result;
    written += batch.length;
    batch = [];
    batchBytes = 0;
    deletes = [];
    return { ok: true };
  };

  for (const path of toWrite) {
    const file = view.get(path)!;
    const raw = await download(file.storagePath).catch(() => null);
    if (!raw) {
      skipped += 1;
      continue;
    }
    const bytes = Buffer.from(raw);
    batch.push({ path, bytes });
    batchBytes += bytes.byteLength;
    manifest[path] = { version: file.versionId, size: bytes.byteLength };
    if (batchBytes >= BATCH_BYTES) {
      const result = await flush();
      if (!result.ok) return result;
    }
  }
  const result = await flush();
  if (!result.ok) return result;
  return { ok: true, files: view.size - skipped, written, deleted: toDelete.length, skipped, view };
}

const synced = new WeakMap<object, Promise<WorkspaceSyncResult>>();

/**
 * Sync once per turn, before its first command. `turn` is any object that
 * lives exactly as long as the turn (the dispatcher's edit state). A failure
 * does not stop the command; it is reported with the command's result.
 */
export function syncWorkspaceOncePerTurn(
  turn: object | undefined,
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  deps?: SyncDeps,
): Promise<WorkspaceSyncResult> {
  if (!turn) return syncWorkspace(db, user, target, deps);
  let pending = synced.get(turn);
  if (!pending) {
    pending = syncWorkspace(db, user, target, deps).catch((error: unknown) => {
      console.warn("[workspace] sync failed", { error: error instanceof Error ? error.name : "unknown" });
      return { ok: false as const, error: "the documents could not be copied to the workstation" };
    });
    synced.set(turn, pending);
  }
  return pending;
}
