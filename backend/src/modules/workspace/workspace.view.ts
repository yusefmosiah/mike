// The workstation's view of a user's documents (goals/mission-16-documents-in-workstation.md):
// every document they can read in Mike, as a path under ~/mike.
//
//   projects/<project>/<folder>/.../<file>
//   library/<folder>/.../<file>
//   templates/<folder>/.../<file>
//
// Paths are stable: names are made safe for a filesystem, and clashes are
// numbered in creation order, so a sync does not shuffle files between names.

import type { Db } from "../../lib/db";
import { listAccessibleProjectIds } from "../../lib/access";

export type WorkspaceFile = {
  documentId: string;
  versionId: string;
  projectId: string | null;
  storagePath: string;
  fileType: string | null;
  sizeBytes: number | null;
};

/** path (relative to ~/mike) -> file */
export type WorkspaceView = Map<string, WorkspaceFile>;

const PAGE = 1000;
const IN_CHUNK = 200;

async function pageAll<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function inChunks<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) rows.push(...(await read(ids.slice(i, i + IN_CHUNK))));
  return rows;
}

/** A name that is one path segment on Linux and readable in a shell. */
export function safeSegment(name: string | null | undefined, fallback = "untitled"): string {
  let segment = (name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (segment === "." || segment === "..") segment = "_";
  if (!segment) segment = fallback;
  // ext4 allows 255 bytes per name; leave room for " (12)".
  while (Buffer.byteLength(segment, "utf8") > 240) segment = segment.slice(0, -1);
  return segment;
}

/** "a.txt", "a (2).txt", ... — the first free name in `taken`. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

type FolderRow = { id: string; name: string; parent_folder_id: string | null };

/** Folder id -> its path segments, following parents (cycles are cut). */
function folderPaths(folders: FolderRow[]): Map<string, string[]> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const memo = new Map<string, string[]>();
  const resolve = (id: string, seen: Set<string>): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return [];
    seen.add(id);
    const parent = folder.parent_folder_id ? resolve(folder.parent_folder_id, seen) : [];
    const path = [...parent, safeSegment(folder.name, "folder")];
    memo.set(id, path);
    return path;
  };
  for (const folder of folders) resolve(folder.id, new Set());
  return memo;
}

type DocumentRow = {
  id: string;
  project_id: string | null;
  folder_id: string | null;
  library_kind: string | null;
  library_folder_id: string | null;
  current_version_id: string | null;
  created_at: string;
};

type VersionRow = {
  id: string;
  filename: string | null;
  file_type: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  deleted_at: string | null;
};

const byCreation = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at);

export async function buildWorkspaceView(
  db: Db,
  user: { id: string; email: string | null | undefined },
): Promise<WorkspaceView> {
  const projectIds = await listAccessibleProjectIds(user.id, user.email, db);
  const projects = await inChunks(projectIds, async (chunk) => {
    const { data, error } = await db.from("projects").select("id, name, created_at").in("id", chunk);
    if (error) throw error;
    return (data ?? []) as { id: string; name: string; created_at: string }[];
  });
  projects.sort(byCreation);
  const projectDirs = new Map<string, string>();
  const takenProjects = new Set<string>();
  for (const project of projects) {
    projectDirs.set(project.id, uniqueName(safeSegment(project.name, "project"), takenProjects));
  }

  const subfolders = await inChunks(projectIds, (chunk) =>
    pageAll<FolderRow>((from, to) =>
      db
        .from("project_subfolders")
        .select("id, name, parent_folder_id")
        .in("project_id", chunk)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  );
  const libraryFolders = await pageAll<FolderRow>((from, to) =>
    db
      .from("library_folders")
      .select("id, name, parent_folder_id")
      .eq("user_id", user.id)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const projectFolderPath = folderPaths(subfolders);
  const libraryFolderPath = folderPaths(libraryFolders);

  const columns = "id, project_id, folder_id, library_kind, library_folder_id, current_version_id, created_at";
  const projectDocuments = await inChunks(projectIds, (chunk) =>
    pageAll<DocumentRow>((from, to) =>
      db
        .from("documents")
        .select(columns)
        .in("project_id", chunk)
        .eq("status", "ready")
        .order("id", { ascending: true })
        .range(from, to),
    ),
  );
  // The library is the user's own documents outside any project or workflow.
  const libraryDocuments = await pageAll<DocumentRow>((from, to) =>
    db
      .from("documents")
      .select(columns)
      .eq("user_id", user.id)
      .is("project_id", null)
      .is("workflow_id", null)
      .in("library_kind", ["file", "template"])
      .eq("status", "ready")
      .order("id", { ascending: true })
      .range(from, to),
  );
  const documents = [...projectDocuments, ...libraryDocuments]
    .filter((doc) => doc.current_version_id && doc.library_kind !== "workflow_asset")
    .sort(byCreation);

  const versions = new Map(
    (
      await inChunks(
        documents.map((doc) => doc.current_version_id!),
        async (chunk) => {
          const { data, error } = await db
            .from("document_versions")
            .select("id, filename, file_type, storage_path, size_bytes, deleted_at")
            .in("id", chunk);
          if (error) throw error;
          return (data ?? []) as VersionRow[];
        },
      )
    ).map((version) => [version.id, version]),
  );

  const view: WorkspaceView = new Map();
  const takenByDir = new Map<string, Set<string>>();
  for (const doc of documents) {
    const version = versions.get(doc.current_version_id!);
    if (!version?.storage_path || version.deleted_at) continue;
    let dir: string[];
    if (doc.project_id) {
      const projectDir = projectDirs.get(doc.project_id);
      if (!projectDir) continue;
      dir = ["projects", projectDir, ...(doc.folder_id ? projectFolderPath.get(doc.folder_id) ?? [] : [])];
    } else {
      dir = [
        doc.library_kind === "template" ? "templates" : "library",
        ...(doc.library_folder_id ? libraryFolderPath.get(doc.library_folder_id) ?? [] : []),
      ];
    }
    const dirKey = dir.join("/");
    const taken = takenByDir.get(dirKey) ?? new Set<string>();
    takenByDir.set(dirKey, taken);
    const name = uniqueName(safeSegment(version.filename, "document"), taken);
    view.set(`${dirKey}/${name}`, {
      documentId: doc.id,
      versionId: version.id,
      projectId: doc.project_id,
      storagePath: version.storage_path,
      fileType: version.file_type,
      sizeBytes: version.size_bytes,
    });
  }
  return view;
}
