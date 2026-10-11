// Brings ~/mike in a user's workstation up to date with what they can read in
// Mike (goals/mission-16-documents-in-workstation.md, phase 1: a copy), and
// ~/skills with their skills (goals/mission-17-skills.md). Only changes
// travel: new and changed files are written, and files the user can no
// longer read, or that were deleted, are removed.

import { createHash } from "node:crypto";
import type { Db } from "../../lib/db";
import { unpackSkillZip } from "../../lib/skillFormat";
import { downloadFile } from "../../lib/storage";
import {
  readWorkspaceManifest,
  SKILLS_ROOT,
  WORKSPACE_ROOT,
  writeWorkspaceBatch,
  type ManifestEntry,
  type WorkspaceBatch,
  type WorkstationTarget,
} from "../../lib/workstation";
import { listWorkstationSkills } from "../workflows/workflows.service";
import { buildWorkspaceView, uniqueName, type WorkspaceView } from "./workspace.view";

/** Bytes per ssh session; a big first sync is several sessions. */
const BATCH_BYTES = 64 * 1024 * 1024;

type Tree = { root: string; writable: string };
const DOCUMENTS: Tree = { root: WORKSPACE_ROOT, writable: "out" };
const SKILLS: Tree = { root: SKILLS_ROOT, writable: "" };

/** One file the tree should hold: a version marker and its bytes on demand. */
type TreeEntry = { version: string; load: () => Promise<Buffer | null> };

type TreeSyncResult =
  | { ok: true; files: number; written: number; deleted: number; skipped: number }
  | { ok: false; error: string };

export type WorkspaceSyncResult =
  | { ok: true; files: number; written: number; deleted: number; skipped: number; view: WorkspaceView }
  | { ok: false; error: string };

export type SyncDeps = {
  buildView?: typeof buildWorkspaceView;
  listSkills?: typeof listWorkstationSkills;
  readManifest?: (
    target: WorkstationTarget,
    root: string,
  ) => Promise<{ ok: true; files: Record<string, ManifestEntry> } | { ok: false; error: string }>;
  writeBatch?: (
    target: WorkstationTarget,
    batch: WorkspaceBatch,
    tree: Tree,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  download?: (storagePath: string) => Promise<ArrayBuffer | null>;
};

async function syncTree(
  target: WorkstationTarget,
  tree: Tree,
  entries: Map<string, TreeEntry>,
  deps: SyncDeps,
): Promise<TreeSyncResult> {
  const readManifest = deps.readManifest ?? ((t, root) => readWorkspaceManifest(t, undefined, root));
  const writeBatch = deps.writeBatch ?? ((t, batch, where) => writeWorkspaceBatch(t, batch, undefined, where));

  const present = await readManifest(target, tree.root);
  if (!present.ok) return present;

  // What the VM will hold afterwards: what it has that is still current,
  // plus what this sync writes.
  const manifest: Record<string, ManifestEntry> = {};
  const toWrite: string[] = [];
  for (const [path, entry] of entries) {
    const there = present.files[path];
    if (there && there.version === entry.version) manifest[path] = there;
    else toWrite.push(path);
  }
  const toDelete = Object.keys(present.files).filter((path) => !entries.has(path) || !manifest[path]);

  let written = 0;
  let skipped = 0;
  let batch: { path: string; bytes: Buffer }[] = [];
  let batchBytes = 0;
  let deletes = toDelete;
  const flush = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!batch.length && !deletes.length) return { ok: true };
    const result = await writeBatch(target, { delete: deletes, files: batch, manifest: { ...manifest } }, tree);
    if (!result.ok) return result;
    written += batch.length;
    batch = [];
    batchBytes = 0;
    deletes = [];
    return { ok: true };
  };

  for (const path of toWrite) {
    const entry = entries.get(path)!;
    const bytes = await entry.load().catch(() => null);
    if (!bytes) {
      skipped += 1;
      continue;
    }
    batch.push({ path, bytes });
    batchBytes += bytes.byteLength;
    manifest[path] = { version: entry.version, size: bytes.byteLength };
    if (batchBytes >= BATCH_BYTES) {
      const result = await flush();
      if (!result.ok) return result;
    }
  }
  const result = await flush();
  if (!result.ok) return result;
  return { ok: true, files: entries.size - skipped, written, deleted: toDelete.length, skipped };
}

export async function syncWorkspace(
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  deps: SyncDeps = {},
): Promise<WorkspaceSyncResult> {
  const download = deps.download ?? downloadFile;
  const view = await (deps.buildView ?? buildWorkspaceView)(db, user);
  const entries = new Map<string, TreeEntry>();
  for (const [path, file] of view) {
    entries.set(path, {
      version: file.versionId,
      load: async () => {
        const raw = await download(file.storagePath);
        return raw ? Buffer.from(raw) : null;
      },
    });
  }
  const result = await syncTree(target, DOCUMENTS, entries, deps);
  return result.ok ? { ...result, view } : result;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** ~/skills/<name>/SKILL.md and each skill's other files. */
export async function syncSkills(
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  deps: SyncDeps = {},
): Promise<TreeSyncResult> {
  const download = deps.download ?? downloadFile;
  const skills = await (deps.listSkills ?? listWorkstationSkills)(db, user);
  const entries = new Map<string, TreeEntry>();
  const taken = new Set<string>();
  for (const skill of skills) {
    const dir = uniqueName(skill.name, taken);
    const skillMd = Buffer.from(skill.skillMd, "utf8");
    entries.set(`${dir}/SKILL.md`, { version: sha256(skillMd), load: async () => skillMd });
    // One download and unpack per bundle, shared by its files.
    let bundle: Promise<Map<string, Buffer>> | null = null;
    const files = () => {
      bundle ??= (async () => {
        const raw = skill.filesPath ? await download(skill.filesPath) : null;
        const unpacked = raw ? await unpackSkillZip(Buffer.from(raw)) : [];
        return new Map(unpacked.map((file) => [file.path, file.bytes]));
      })();
      return bundle;
    };
    for (const file of skill.files) {
      if (file.path === "SKILL.md") continue;
      entries.set(`${dir}/${file.path}`, {
        version: `${skill.filesPath}:${file.path}`,
        load: async () => (await files()).get(file.path) ?? null,
      });
    }
  }
  return syncTree(target, SKILLS, entries, deps);
}

const synced = new WeakMap<object, Promise<WorkspaceSyncResult>>();

/**
 * Sync once per turn, before its first command: documents, then skills.
 * `turn` is any object that lives exactly as long as the turn (the
 * dispatcher's edit state). A failure does not stop the command; it is
 * reported with the command's result.
 */
export function syncWorkspaceOncePerTurn(
  turn: object | undefined,
  db: Db,
  user: { id: string; email: string | null | undefined },
  target: WorkstationTarget,
  deps?: SyncDeps,
): Promise<WorkspaceSyncResult> {
  const run = async (): Promise<WorkspaceSyncResult> => {
    const documents = await syncWorkspace(db, user, target, deps);
    const skills = await syncSkills(db, user, target, deps).catch(() => ({ ok: false as const, error: "" }));
    if (!documents.ok) return documents;
    if (!skills.ok) return { ok: false, error: "the skills could not be copied to the workstation" };
    return documents;
  };
  if (!turn) return run();
  let pending = synced.get(turn);
  if (!pending) {
    pending = run().catch((error: unknown) => {
      console.warn("[workspace] sync failed", { error: error instanceof Error ? error.name : "unknown" });
      return { ok: false as const, error: "the documents could not be copied to the workstation" };
    });
    synced.set(turn, pending);
  }
  return pending;
}
