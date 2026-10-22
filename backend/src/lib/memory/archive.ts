import { checkProjectAccess, listAccessibleProjectIds } from "../access";
import { chunkArray } from "../arrays";
import type { Db } from "../dbq/types";
import { getMemoryCurrent, type MemoryFileRow } from "./files";

const PROJECT_BATCH_SIZE = 200;

type ProjectLabel = {
  id: string;
  name: string | null;
};

function archiveSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-")
    .replace(/\.{2,}/g, "-")
    .trim()
    .replace(/[. ]+$/g, "");
  return Array.from(normalized || "project")
    .slice(0, 80)
    .join("");
}

async function loadProjectLabels(
  db: Db,
  projectIds: string[],
): Promise<ProjectLabel[]> {
  const projects: ProjectLabel[] = [];
  for (const batch of chunkArray(projectIds, PROJECT_BATCH_SIZE)) {
    const { data, error } = await db
      .from("projects")
      .select("id, name")
      .in("id", batch);
    if (error) throw new Error("Failed to load projects for memory export");
    projects.push(...((data ?? []) as ProjectLabel[]));
  }
  return projects.sort(
    (left, right) =>
      (left.name ?? "").localeCompare(right.name ?? "") ||
      left.id.localeCompare(right.id),
  );
}

/** A file's versions, oldest first, as `versions/0001-<source>.md` beside it. */
async function addVersions(
  zip: { file(path: string, content: string): unknown },
  db: Db,
  file: MemoryFileRow,
  directory: string,
): Promise<void> {
  const { data, error } = await db
    .from("memory_file_versions")
    .select("version_number, source, content")
    .eq("memory_file_id", file.id)
    .order("version_number", { ascending: true });
  if (error) throw new Error("Failed to load memory versions for export");
  for (const version of (data ?? []) as { version_number: number; source: string; content: string }[]) {
    const number = String(version.version_number).padStart(4, "0");
    zip.file(`${directory}/versions/${number}-${version.source}.md`, version.content ?? "");
  }
}

/** Build a ZIP containing the caller's app memory and every project memory
 * they can still view when the background export actually runs, each with
 * its earlier versions. */
export async function buildMemoryArchive(
  db: Db,
  userId: string,
  userEmail: string | null,
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const appMemory = await getMemoryCurrent(db, "user", userId);
  zip.file("app/memory.md", appMemory.current.content);
  await addVersions(zip, db, appMemory.file, "app");

  const projectIds = await listAccessibleProjectIds(userId, userEmail, db);
  const projects = await loadProjectLabels(db, projectIds);
  for (const project of projects) {
    // Access can change while an export waits in the durable queue. Re-check
    // immediately before reading each shared file and omit revoked projects.
    const access = await checkProjectAccess(project.id, userId, userEmail, db);
    if (!access.ok) continue;
    const memory = await getMemoryCurrent(db, "project", project.id);
    const safeId = project.id.replace(/[^a-zA-Z0-9-]/g, "") || "project";
    const directory = `${archiveSegment(project.name ?? "project")}--${safeId}`;
    zip.file(`projects/${directory}/memory.md`, memory.current.content);
    await addVersions(zip, db, memory.file, `projects/${directory}`);
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}
