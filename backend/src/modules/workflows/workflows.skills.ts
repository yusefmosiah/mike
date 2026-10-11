// Skills (goals/mission-17-skills.md): an assistant workflow is a skill in
// the standard format. Its SKILL.md is the row's title (as the name),
// description, frontmatter and prompt_md (the body); its other files are one
// zip in object storage. Every saved state is a row in workflow_versions.
//
// Saving from chat, importing and restoring all come through `saveSkill`,
// which versions a skill the user can edit, copies one they cannot, and
// otherwise creates one. Nothing here runs a skill's code.

import { randomUUID } from "node:crypto";
import { type Db } from "../../lib/db";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import {
  SkillFormatError,
  packSkillFiles,
  renderSkillMd,
  skillName,
  unpackSkillZip,
  type Skill,
  type SkillFile,
  type SkillFileEntry,
} from "../../lib/skillFormat";
import { deleteFilesBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import { resolveWorkflowAccess } from "./workflows.access";
import { importSkillFromGithub, importSkillFromZip, type ImportedSkill } from "./workflows.skillImport";
import type { WorkflowRecord } from "./workflows.types";

export type SkillVersionSource = "original" | "edit" | "chat" | "import" | "restore";

export type SkillRow = WorkflowRecord & {
  description?: string | null;
  source_url?: string | null;
  files?: SkillFileEntry[] | null;
  files_path?: string | null;
  frontmatter?: Record<string, unknown> | null;
};

export type SkillVersion = {
  id: string;
  version_number: number;
  title: string;
  description: string | null;
  files: SkillFileEntry[] | null;
  source: SkillVersionSource;
  source_url: string | null;
  created_at: string;
};

export type SavedSkill = {
  skillId: string;
  name: string;
  title: string;
  versionNumber: number;
  created: boolean;
  /** Set when the user could not edit the skill named, so a copy was made. */
  copiedFrom?: string;
  description: string;
  files: SkillFileEntry[] | null;
  filesPath: string | null;
};

const SNAPSHOT_COLUMNS = "title, description, prompt_md, files, files_path, frontmatter, source_url";

/** The skill's name as the standard spells it, from its title. */
export function skillNameOf(row: Pick<SkillRow, "title">): string {
  return skillName(row.title ?? "") || "skill";
}

/** SKILL.md as a workstation or an export sees it. */
export function skillMdOf(row: SkillRow): string {
  return renderSkillMd({
    name: skillNameOf(row),
    description: row.description?.trim() || row.title || skillNameOf(row),
    body: row.prompt_md ?? "",
    extra: row.frontmatter ?? {},
  });
}

/** A skill's other files, read back from storage. */
export async function loadSkillFiles(row: Pick<SkillRow, "files_path">): Promise<SkillFile[]> {
  if (!row.files_path) return [];
  const zip = await downloadFile(row.files_path);
  if (!zip) return [];
  return unpackSkillZip(Buffer.from(zip));
}

async function nextVersionNumber(db: Db, workflowId: string): Promise<number> {
  const { data } = await db
    .from("workflow_versions")
    .select("version_number")
    .eq("workflow_id", workflowId)
    .order("version_number", { ascending: false })
    .limit(1);
  const latest = ((data ?? []) as { version_number: number }[])[0]?.version_number ?? 0;
  return latest + 1;
}

/**
 * Records the row's current state as its next version. A skill that predates
 * versions gets its existing state recorded as version 1 ("original") the
 * first time it changes, so the history starts from what the user had.
 */
export async function recordSkillVersion(
  db: Db,
  workflowId: string,
  userId: string,
  source: SkillVersionSource,
): Promise<number | null> {
  const { data: row } = await db.from("workflows").select(SNAPSHOT_COLUMNS).eq("id", workflowId).single();
  if (!row) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const versionNumber = await nextVersionNumber(db, workflowId);
    const { error } = await db.from("workflow_versions").insert({
      ...(row as Record<string, unknown>),
      workflow_id: workflowId,
      version_number: versionNumber,
      source,
      created_by: userId,
    });
    if (!error) return versionNumber;
    // Someone else recorded a version first; take the next number.
    if ((error as { code?: string }).code !== "23505") return null;
  }
  return null;
}

/** Records version 1 from the current state if the skill has no versions yet. */
export async function ensureOriginalVersion(db: Db, workflowId: string, userId: string): Promise<void> {
  const { data } = await db.from("workflow_versions").select("id").eq("workflow_id", workflowId).limit(1);
  if (((data ?? []) as unknown[]).length === 0) await recordSkillVersion(db, workflowId, userId, "original");
}

/** The fields a skill sets on its workflows row. */
async function skillColumns(userId: string, skill: Skill): Promise<Record<string, unknown>> {
  const packed = await packSkillFiles(skill.files);
  let filesPath: string | null = null;
  if (packed) {
    filesPath = `skills/${userId}/${randomUUID()}.zip`;
    await uploadFile(
      filesPath,
      packed.zip.buffer.slice(packed.zip.byteOffset, packed.zip.byteOffset + packed.zip.byteLength) as ArrayBuffer,
      "application/zip",
    );
  }
  return {
    description: skill.description,
    prompt_md: skill.body,
    frontmatter: Object.keys(skill.extra).length ? skill.extra : null,
    files: packed?.entries ?? null,
    files_path: filesPath,
  };
}

async function ownSkillNamed(db: Db, userId: string, name: string): Promise<SkillRow | null> {
  const { data } = await db
    .from("workflows")
    .select("id, title, user_id, type, created_at")
    .eq("user_id", userId)
    .eq("type", "assistant")
    .order("created_at", { ascending: true });
  return ((data ?? []) as SkillRow[]).find((row) => skillNameOf(row) === name) ?? null;
}

/**
 * Saves a skill for the user:
 * - `skillId` names one they can edit: a new version of it;
 * - `skillId` names one they can only read: a copy of their own;
 * - otherwise, their own skill with the same name gets a new version;
 * - otherwise a new skill.
 */
export async function saveSkill(
  db: Db,
  user: { id: string; email: string | null | undefined },
  input: { skill: Skill; skillId?: string | null; source: "chat" | "import"; sourceUrl?: string | null },
): Promise<ServiceResult<SavedSkill>> {
  const { skill } = input;
  let targetId: string | null = null;
  let copiedFrom: string | undefined;
  let title = skill.name;

  if (input.skillId) {
    const access = await resolveWorkflowAccess(db, input.skillId, user.id, user.email);
    if (!access || access.workflow.type !== "assistant") {
      return failure("not_found", "There is no skill with that id that you can read.");
    }
    if (access.allowEdit) {
      targetId = input.skillId;
      // Keep a legacy title ("Contract Review") when the name is unchanged.
      if (skillNameOf(access.workflow) === skill.name) title = access.workflow.title ?? skill.name;
    } else {
      copiedFrom = access.workflow.title ?? undefined;
    }
  }
  if (!targetId && !copiedFrom) {
    const existing = await ownSkillNamed(db, user.id, skill.name);
    if (existing) {
      targetId = existing.id;
      title = existing.title ?? skill.name;
    }
  }

  try {
    const columns = await skillColumns(user.id, skill);
    // A copy keeps its provenance; an import records where it came from.
    const sourceUrl = input.sourceUrl ?? null;
    if (targetId) {
      await ensureOriginalVersion(db, targetId, user.id);
      const { error } = await db
        .from("workflows")
        .update({ ...columns, title, ...(input.source === "import" ? { source_url: sourceUrl } : {}) })
        .eq("id", targetId)
        .select("id")
        .single();
      if (error) return internalFailure(error);
      const versionNumber = await recordSkillVersion(db, targetId, user.id, input.source);
      return ok({
        skillId: targetId,
        name: skill.name,
        title,
        versionNumber: versionNumber ?? 0,
        created: false,
        description: skill.description,
        files: columns.files as SkillFileEntry[] | null,
        filesPath: columns.files_path as string | null,
      });
    }
    const { data, error } = await db
      .from("workflows")
      .insert({ ...columns, user_id: user.id, title, type: "assistant", source_url: sourceUrl })
      .select("id")
      .single();
    if (error || !data) return internalFailure(error);
    const skillId = (data as { id: string }).id;
    const versionNumber = await recordSkillVersion(db, skillId, user.id, input.source);
    return ok({
      skillId,
      name: skill.name,
      title,
      versionNumber: versionNumber ?? 1,
      created: true,
      description: skill.description,
      files: columns.files as SkillFileEntry[] | null,
      filesPath: columns.files_path as string | null,
      ...(copiedFrom ? { copiedFrom } : {}),
    });
  } catch (error) {
    return internalFailure(error);
  }
}

export async function listSkillVersions(
  db: Db,
  user: { id: string; email: string | null | undefined },
  workflowId: string,
): Promise<ServiceResult<SkillVersion[]>> {
  const access = await resolveWorkflowAccess(db, workflowId, user.id, user.email);
  if (!access) return failure("not_found", "Workflow not found");
  const { data, error } = await db
    .from("workflow_versions")
    .select("id, version_number, title, description, files, source, source_url, created_at")
    .eq("workflow_id", workflowId)
    .order("version_number", { ascending: false });
  if (error) return internalFailure(error);
  return ok((data ?? []) as SkillVersion[]);
}

/** Makes an earlier version current again, as a new version. */
export async function restoreSkillVersion(
  db: Db,
  user: { id: string; email: string | null | undefined },
  workflowId: string,
  versionId: string,
): Promise<ServiceResult<{ versionNumber: number }>> {
  const access = await resolveWorkflowAccess(db, workflowId, user.id, user.email);
  if (!access) return failure("not_found", "Workflow not found");
  if (!access.allowEdit) return failure("forbidden", "You cannot edit this workflow.");
  const { data: version } = await db
    .from("workflow_versions")
    .select(SNAPSHOT_COLUMNS)
    .eq("id", versionId)
    .eq("workflow_id", workflowId)
    .single();
  if (!version) return failure("not_found", "Version not found");
  const { error } = await db
    .from("workflows")
    .update(version as Record<string, unknown>)
    .eq("id", workflowId)
    .select("id")
    .single();
  if (error) return internalFailure(error);
  const versionNumber = await recordSkillVersion(db, workflowId, user.id, "restore");
  return ok({ versionNumber: versionNumber ?? 0 });
}

/** Storage keys of every bundle a workflow's versions reference, for deletion. */
export async function skillBundleKeys(db: Db, workflowId: string): Promise<string[]> {
  const [{ data: row }, { data: versions }] = await Promise.all([
    db.from("workflows").select("files_path").eq("id", workflowId).maybeSingle(),
    db.from("workflow_versions").select("files_path").eq("workflow_id", workflowId),
  ]);
  const keys = [row, ...((versions ?? []) as unknown[])]
    .map((entry) => (entry as { files_path?: string | null } | null)?.files_path)
    .filter((key): key is string => !!key);
  return [...new Set(keys)];
}

export function deleteSkillBundles(keys: string[]): void {
  if (keys.length) deleteFilesBestEffort(keys, "skill bundle");
}

/** Imports a skill from a GitHub link or a zip and saves it for the user. */
export async function importSkill(
  db: Db,
  user: { id: string; email: string | null | undefined },
  from: { url: string } | { zip: Buffer; filename?: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ServiceResult<SavedSkill & { sourceUrl: string | null }>> {
  let imported: ImportedSkill;
  try {
    imported =
      "url" in from
        ? await importSkillFromGithub(from.url, { fetchImpl: deps.fetchImpl })
        : await importSkillFromZip(from.zip, from.filename);
  } catch (error) {
    if (error instanceof SkillFormatError) return failure("validation", error.message, "invalid_skill");
    return failure("unavailable", "The skill could not be fetched. Try again in a minute.", "skill_fetch_failed");
  }
  const saved = await saveSkill(db, user, { skill: imported.skill, source: "import", sourceUrl: imported.sourceUrl });
  return saved.ok ? ok({ ...saved.data, sourceUrl: imported.sourceUrl }) : saved;
}

/** The skill as a standard folder in a zip: <name>/SKILL.md and its files. */
export async function exportSkill(
  db: Db,
  user: { id: string; email: string | null | undefined },
  workflowId: string,
): Promise<ServiceResult<{ filename: string; zip: Buffer }>> {
  const access = await resolveWorkflowAccess(db, workflowId, user.id, user.email);
  if (!access || access.workflow.type !== "assistant") return failure("not_found", "Workflow not found");
  const row = access.workflow as SkillRow;
  const name = skillNameOf(row);
  const files = await loadSkillFiles(row);
  const packed = await packSkillFiles([
    { path: `${name}/SKILL.md`, bytes: Buffer.from(skillMdOf(row), "utf8") },
    ...files.map((file) => ({ path: `${name}/${file.path}`, bytes: file.bytes })),
  ]);
  return ok({ filename: `${name}.zip`, zip: packed!.zip });
}

/**
 * The skills a user's workstation holds under ~/skills: their own assistant
 * workflows and those shared with them, oldest first (so numbered names stay
 * put), each as SKILL.md plus a loader for its other files.
 */
export async function listWorkstationSkills(
  db: Db,
  user: { id: string; email: string | null | undefined },
): Promise<{ name: string; skillMd: string; files: SkillFileEntry[]; filesPath: string | null }[]> {
  const columns = "id, title, description, prompt_md, frontmatter, files, files_path, created_at";
  const { data: own, error } = await db
    .from("workflows")
    .select(columns)
    .eq("user_id", user.id)
    .eq("type", "assistant");
  if (error) throw error;
  const rows = [...((own ?? []) as SkillRow[])];
  const email = (user.email ?? "").trim().toLowerCase();
  if (email) {
    const { data: shares } = await db.from("workflow_shares").select("workflow_id").eq("shared_with_email", email);
    const ids = [...new Set(((shares ?? []) as { workflow_id: string }[]).map((share) => share.workflow_id))].filter(
      (id) => !rows.some((row) => row.id === id),
    );
    if (ids.length) {
      const { data: shared } = await db.from("workflows").select(columns).in("id", ids).eq("type", "assistant");
      rows.push(...((shared ?? []) as SkillRow[]));
    }
  }
  return rows
    .filter((row) => row.prompt_md)
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id))
    .map((row) => ({
      name: skillNameOf(row),
      skillMd: skillMdOf(row),
      files: row.files ?? [],
      filesPath: row.files_path ?? null,
    }));
}
