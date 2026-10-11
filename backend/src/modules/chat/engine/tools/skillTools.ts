// save_skill, install_skill and read_workflow's file reads
// (goals/mission-17-skills.md). The dispatcher calls these and reports the
// result; saving goes through the workflows facade.

import path from "node:path";
import type { Db } from "../../../../lib/db";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  parseSkillMd,
  SkillFormatError,
  skillFromFiles,
  skillFromParts,
  skillName,
  unpackSkillZip,
  type Skill,
} from "../../../../lib/skillFormat";
import { decodeTextFile, TextRejectedError, textForModel } from "../../../../lib/textFiles";
import { downloadFile } from "../../../../lib/storage";
import { readWorkstationTree, type WorkstationTarget } from "../../../../lib/workstation";
import { importSkill, saveSkill, type SavedSkill } from "../../../workflows/workflows.service";
import type { WorkflowStore } from "../types";

type User = { id: string; email: string | null | undefined };

export type SkillToolResult =
  | { ok: true; saved: SavedSkill; body: string; sourceUrl?: string | null }
  | { ok: false; error: string };

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The skill save_skill describes: inline instructions, or a workstation folder. */
async function skillFromArgs(
  args: Record<string, unknown>,
  ctx: { workstation: WorkstationTarget | null; workspaceOwned: boolean },
  readTree: typeof readWorkstationTree,
): Promise<Skill | { error: string }> {
  const folder = str(args.path);
  if (folder) {
    if (!ctx.workstation || !ctx.workspaceOwned) {
      return { error: "path works only in your own workstation; pass the instructions instead." };
    }
    const read = await readTree(ctx.workstation, folder, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES });
    if (!read.ok) return { error: `Could not read ${folder}: ${read.error}.` };
    const skill = skillFromFiles(read.files, str(args.name) ?? path.posix.basename(folder.replace(/\/+$/, "")));
    return skillFromParts({
      ...skill,
      name: str(args.name) ?? skill.name,
      description: str(args.description) ?? skill.description,
    });
  }
  const instructions = typeof args.instructions === "string" ? args.instructions : "";
  if (!instructions.trim()) {
    return { error: "Give the skill's instructions (or, in the workstation, the path of its folder)." };
  }
  const { frontmatter, body } = parseSkillMd(instructions);
  const { name: fmName, description: fmDescription, ...extra } = frontmatter ?? {};
  const files =
    args.files && typeof args.files === "object" && !Array.isArray(args.files)
      ? Object.entries(args.files as Record<string, unknown>)
          .filter(([, content]) => typeof content === "string")
          .map(([filePath, content]) => ({ path: filePath, bytes: Buffer.from(content as string, "utf8") }))
      : [];
  return skillFromParts({
    name: str(args.name) ?? (typeof fmName === "string" ? fmName : ""),
    description: str(args.description) ?? (typeof fmDescription === "string" ? fmDescription : null),
    body,
    extra,
    files,
  });
}

export async function runSaveSkill(
  db: Db,
  user: User,
  args: Record<string, unknown>,
  ctx: { workstation: WorkstationTarget | null; workspaceOwned: boolean },
  deps: { readTree?: typeof readWorkstationTree } = {},
): Promise<SkillToolResult> {
  let skill: Skill;
  try {
    const made = await skillFromArgs(args, ctx, deps.readTree ?? readWorkstationTree);
    if ("error" in made) return { ok: false, error: made.error };
    skill = made;
  } catch (error) {
    if (error instanceof SkillFormatError) return { ok: false, error: error.message };
    throw error;
  }
  const saved = await saveSkill(db, user, { skill, skillId: str(args.skill_id) ?? null, source: "chat" });
  if (!saved.ok) {
    return { ok: false, error: saved.kind === "error" ? "The skill could not be saved." : saved.detail };
  }
  return { ok: true, saved: saved.data, body: skill.body };
}

export async function runInstallSkill(
  db: Db,
  user: User,
  args: Record<string, unknown>,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SkillToolResult> {
  const url = str(args.url);
  if (!url) return { ok: false, error: "Give the GitHub link to the skill." };
  const result = await importSkill(db, user, { url }, deps);
  if (!result.ok) {
    return { ok: false, error: result.kind === "error" ? "The skill could not be installed." : result.detail };
  }
  const { sourceUrl, ...saved } = result.data;
  return { ok: true, saved, body: "", sourceUrl };
}

/** The tool result the model sees for a save or an install. */
export function skillSavedMessage(result: Extract<SkillToolResult, { ok: true }>, installed: boolean): string {
  const { saved } = result;
  const what = installed ? "Installed" : "Saved";
  const version = saved.created ? "" : ` as version ${saved.versionNumber}`;
  return JSON.stringify({
    ok: true,
    skill_id: saved.skillId,
    name: saved.name,
    version: saved.versionNumber,
    created: saved.created,
    ...(saved.copiedFrom ? { copied_from: saved.copiedFrom } : {}),
    ...(result.sourceUrl ? { source: result.sourceUrl } : {}),
    message:
      `${what} the skill '${saved.name}'${version}.` +
      (saved.copiedFrom ? ` You could not edit '${saved.copiedFrom}', so this is the user's own copy.` : "") +
      " Every chat lists it from its next turn, and the Workflows page shows it with its versions.",
  });
}

/**
 * The existing skill a chat save would overwrite without its current text
 * having been read this turn, or null. A model asked to change one part of
 * a skill otherwise rewrites the whole of it from the one-line listing and
 * drops what the user asked to keep (staging, 2026-10-11). A save from a
 * workstation folder is grounded in its files and is not checked.
 */
export function unreadSkillEdit(
  store: WorkflowStore | undefined,
  args: Record<string, unknown>,
): { id: string; name: string } | null {
  if (!store || str(args.path)) return null;
  const id = str(args.skill_id);
  const name = skillName(str(args.name) ?? "");
  const match = id
    ? store.has(id)
      ? ([id, store.get(id)!] as const)
      : undefined
    : Array.from(store.entries()).find(([, skill]) => name && skill.name === name);
  if (!match || match[1].read) return null;
  return { id: match[0], name: match[1].name ?? match[1].title };
}

/** Makes a saved skill readable for the rest of this turn. */
export function rememberSkill(store: WorkflowStore | undefined, result: Extract<SkillToolResult, { ok: true }>): void {
  if (!store) return;
  const { saved } = result;
  store.set(saved.skillId, {
    title: saved.title,
    skill_md: result.body || store.get(saved.skillId)?.skill_md || "",
    listed: true,
    read: true,
    name: saved.name,
    description: saved.description,
    files: saved.files,
    files_path: saved.filesPath,
  });
}

const MAX_FILE_CHARS = 60_000;

/** One text file from a skill's stored bundle, for read_workflow's `file`. */
export async function readSkillFile(
  skill: { files?: { path: string }[] | null; files_path?: string | null },
  file: string,
  deps: { download?: (key: string) => Promise<ArrayBuffer | null> } = {},
): Promise<string> {
  const wanted = file.replace(/^\.?\//, "");
  if (!skill.files_path || !skill.files?.some((entry) => entry.path === wanted)) {
    const listing = (skill.files ?? []).map((entry) => entry.path).join(", ");
    return listing ? `The skill has no file '${wanted}'. Its files: ${listing}.` : "The skill has no other files.";
  }
  const zip = await (deps.download ?? downloadFile)(skill.files_path);
  if (!zip) return `'${wanted}' could not be read.`;
  const entry = (await unpackSkillZip(Buffer.from(zip))).find((candidate) => candidate.path === wanted);
  if (!entry) return `'${wanted}' could not be read.`;
  try {
    const text = textForModel(decodeTextFile(entry.bytes));
    return text.length > MAX_FILE_CHARS
      ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[The file continues; it has ${text.length} characters.]`
      : text;
  } catch (error) {
    if (error instanceof TextRejectedError) {
      return `'${wanted}' is not a text file (${entry.bytes.byteLength} bytes); it can be used from the workstation.`;
    }
    throw error;
  }
}

/** What read_workflow adds after SKILL.md about the skill's other files. */
export function skillFilesNotice(
  skill: { name?: string; files?: { path: string }[] | null },
  workstation: boolean,
): string {
  const files = skill.files ?? [];
  if (!files.length) return "";
  const listing = files
    .slice(0, 50)
    .map((entry) => `- ${entry.path}`)
    .join("\n");
  const more = files.length > 50 ? `\n- ... and ${files.length - 50} more` : "";
  const name = skillName(skill.name ?? "") || "skill";
  const where = workstation
    ? `They are in ~/skills/${name}/ in the workstation; run its scripts there with run_command. Text files can also be read with read_workflow and file.`
    : "Read a text file with read_workflow and file. Scripts cannot run here: there is no workstation in this chat.";
  return `\n\nThis skill's other files:\n${listing}${more}\n${where}`;
}
