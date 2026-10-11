// Skills in the standard format (goals/mission-17-skills.md): a folder with a
// SKILL.md, whose YAML frontmatter has a name and a description, plus any
// other files (scripts/, references/, assets/).
//
// Pure functions: parse and render SKILL.md, check a folder's paths and sizes,
// and pack the other files into one zip for storage. Nothing here runs a
// skill's code. The frontmatter check is the standard's, relaxed: a missing
// description is taken from the body, and extra fields are kept.

import JSZip from "jszip";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SKILL_FILE = "SKILL.md";
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_MD_BYTES = 256 * 1024;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

/** A refusal whose message can be shown to the user and the model as is. */
export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFormatError";
  }
}

export type SkillFile = { path: string; bytes: Buffer };
export type SkillFileEntry = { path: string; size: number };

export type Skill = {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Frontmatter fields other than name and description, kept as found. */
  extra: Record<string, unknown>;
  /** Every file except SKILL.md. */
  files: SkillFile[];
};

/** The standard's name: lowercase letters, digits and single hyphens. */
export function skillName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
}

/** SKILL.md's frontmatter (null when it has none) and body. */
export function parseSkillMd(text: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: normalized.trim() };
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch {
    throw new SkillFormatError("SKILL.md has frontmatter that is not valid YAML.");
  }
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new SkillFormatError("SKILL.md's frontmatter must be a set of fields.");
  }
  return { frontmatter: (parsed ?? {}) as Record<string, unknown>, body: match[2]!.trim() };
}

/** The first sentence or line of the body, for a skill without a description. */
export function describeFromBody(body: string): string {
  const text = body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  const sentence = text.match(/^(.{1,300}?[.!?])(\s|$)/)?.[1] ?? text.slice(0, 300);
  return sentence.trim();
}

/** SKILL.md for a skill: frontmatter with name and description first. */
export function renderSkillMd(skill: Pick<Skill, "name" | "description" | "body" | "extra">): string {
  const frontmatter = stringifyYaml(
    { name: skill.name, description: skill.description, ...skill.extra },
    { lineWidth: 0 },
  ).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.body.trim()}\n`;
}

function checkedPath(raw: string): string {
  const path = raw.replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new SkillFormatError(`The skill contains an unsafe path: ${JSON.stringify(raw.slice(0, 200))}.`);
  }
  return path;
}

/** Checks paths, counts and sizes; for a whole folder, drops a shared top folder. */
function checkedFiles(files: SkillFile[], folder = false): SkillFile[] {
  if (files.length > MAX_SKILL_FILES) {
    throw new SkillFormatError(`A skill can have at most ${MAX_SKILL_FILES} files.`);
  }
  let paths = files.map((file) => checkedPath(file.path));
  // A folder zipped from outside ("my-skill/SKILL.md") is the same skill.
  if (folder && !paths.includes(SKILL_FILE)) {
    const top = paths[0]?.split("/")[0];
    if (top && paths.every((path) => path.startsWith(`${top}/`))) {
      paths = paths.map((path) => path.slice(top.length + 1));
    }
  }
  const seen = new Set<string>();
  let total = 0;
  const result = files.map((file, index) => {
    const path = paths[index]!;
    if (seen.has(path)) throw new SkillFormatError(`The skill has ${path} twice.`);
    seen.add(path);
    if (file.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillFormatError(`${path} is larger than ${MAX_SKILL_FILE_BYTES / 1024 / 1024} MB.`);
    }
    total += file.bytes.byteLength;
    return { path, bytes: file.bytes };
  });
  if (total > MAX_SKILL_BYTES) {
    throw new SkillFormatError(`A skill can hold at most ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
  }
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A skill from a folder's files. `fallbackName` is used when SKILL.md names
 * none (the folder's name, or what the user called it).
 */
export function skillFromFiles(files: SkillFile[], fallbackName?: string): Skill {
  const checked = checkedFiles(files, true);
  const skillMd = checked.find((file) => file.path === SKILL_FILE);
  if (!skillMd) throw new SkillFormatError("A skill needs a SKILL.md at the top of its folder.");
  if (skillMd.bytes.byteLength > MAX_SKILL_MD_BYTES) {
    throw new SkillFormatError("SKILL.md is larger than 256 KB.");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(skillMd.bytes);
  } catch {
    throw new SkillFormatError("SKILL.md is not UTF-8 text.");
  }
  const { frontmatter, body } = parseSkillMd(source);
  const { name: rawName, description: rawDescription, ...extra } = frontmatter ?? {};
  return skillFromParts({
    name: text(rawName) ?? fallbackName ?? "",
    description: text(rawDescription),
    body,
    extra,
    files: checked.filter((file) => file !== skillMd),
  });
}

/** A skill from its parts, normalized and checked. */
export function skillFromParts(parts: {
  name: string;
  description?: string | null;
  body: string;
  extra?: Record<string, unknown>;
  files?: SkillFile[];
}): Skill {
  const name = skillName(parts.name);
  if (!name) throw new SkillFormatError("A skill needs a name made of letters, digits or hyphens.");
  const body = parts.body.trim();
  if (!body) throw new SkillFormatError("A skill needs instructions in its SKILL.md.");
  const description = (text(parts.description) ?? describeFromBody(body)).replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION_LENGTH);
  const files = parts.files ? checkedFiles(parts.files).filter((file) => file.path !== SKILL_FILE) : [];
  return { name, description, body, extra: parts.extra ?? {}, files };
}

/** The other files as one zip, and their listing. Null when there are none. */
export async function packSkillFiles(files: SkillFile[]): Promise<{ zip: Buffer; entries: SkillFileEntry[] } | null> {
  if (!files.length) return null;
  const zip = new JSZip();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) zip.file(file.path, file.bytes, { date: new Date(0), createFolders: false });
  return {
    zip: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    entries: sorted.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
  };
}

/** An entry's bytes, stopping as soon as they pass `limit`. */
function inflateCapped(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        (stream as unknown as { pause(): void }).pause();
        reject(new SkillFormatError(`A skill can hold at most ${MAX_SKILL_BYTES / 1024 / 1024} MB, at most ${MAX_SKILL_FILE_BYTES / 1024 / 1024} MB per file.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () => reject(new SkillFormatError("The zip archive is damaged.")));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const SYMLINK = 0o120000;
const FILE_TYPE = 0o170000;

/**
 * Files from a zip: an uploaded skill, or a stored bundle. Refuses symlinks,
 * unsafe paths and anything over the size limits, counting the bytes actually
 * inflated rather than what the archive claims.
 */
export async function unpackSkillZip(bytes: Buffer): Promise<SkillFile[]> {
  if (bytes.byteLength > MAX_SKILL_BYTES) {
    throw new SkillFormatError(`A skill can hold at most ${MAX_SKILL_BYTES / 1024 / 1024} MB.`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new SkillFormatError("The file is not a zip archive.");
  }
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").includes(".DS_Store"),
  );
  if (entries.length > MAX_SKILL_FILES) {
    throw new SkillFormatError(`A skill can have at most ${MAX_SKILL_FILES} files.`);
  }
  const files: SkillFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const mode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    if ((mode & FILE_TYPE) === SYMLINK) {
      throw new SkillFormatError(`The skill contains a symbolic link: ${entry.name.slice(0, 200)}.`);
    }
    // JSZip resolves "../" in names on load; the original is what was sent.
    checkedPath((entry as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name);
    const content = await inflateCapped(entry, Math.min(MAX_SKILL_FILE_BYTES, MAX_SKILL_BYTES - total));
    total += content.byteLength;
    files.push({ path: entry.name, bytes: content });
  }
  return files;
}
