import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../../../../lib/db";
import { packSkillFiles } from "../../../../../lib/skillFormat";
import type { WorkstationTarget } from "../../../../../lib/workstation";

const workflows = vi.hoisted(() => ({ saveSkill: vi.fn(), importSkill: vi.fn() }));
vi.mock("../../../../workflows/workflows.service", () => workflows);

import { skillsPromptSection } from "../../contextBuilders";
import type { WorkflowStore } from "../../types";
import {
  readSkillFile,
  rememberSkill,
  runInstallSkill,
  runSaveSkill,
  skillFilesNotice,
  skillSavedMessage,
  unreadSkillEdit,
} from "../skillTools";

const db = {} as Db;
const user = { id: "u1", email: "me@example.com" };
const target: WorkstationTarget = { host: "vm", user: "agent", identityFile: "/k" };
const saved = {
  skillId: "w1",
  name: "deposition-summary",
  title: "deposition-summary",
  versionNumber: 1,
  created: true,
  description: "Summarize a deposition.",
  files: null,
  filesPath: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  workflows.saveSkill.mockResolvedValue({ ok: true, data: saved });
});

describe("runSaveSkill", () => {
  it("codifies a prompt given inline, with small files", async () => {
    const result = await runSaveSkill(
      db,
      user,
      {
        name: "Deposition Summary",
        description: "Summarize a deposition transcript by topic, with page:line cites.",
        instructions: "## Steps\n1. Ask which transcript.\n2. Summarize by topic.",
        files: { "references/format.md": "# Format", "ignored.bin": 3 },
      },
      { workstation: null, workspaceOwned: false },
    );
    expect(result).toMatchObject({ ok: true, saved: { skillId: "w1" } });
    const { skill, skillId, source } = workflows.saveSkill.mock.calls[0]![2];
    expect({ skillId, source }).toEqual({ skillId: null, source: "chat" });
    expect(skill).toMatchObject({
      name: "deposition-summary",
      description: "Summarize a deposition transcript by topic, with page:line cites.",
      body: "## Steps\n1. Ask which transcript.\n2. Summarize by topic.",
    });
    expect(skill.files.map((f: { path: string }) => f.path)).toEqual(["references/format.md"]);
  });

  it("reads a whole SKILL.md given as instructions, frontmatter and all", async () => {
    await runSaveSkill(
      db,
      user,
      {
        name: "",
        instructions: "---\nname: lease-abstract\ndescription: Abstract a lease.\nlicense: MIT\n---\nSteps.",
        skill_id: "w9",
      },
      { workstation: null, workspaceOwned: false },
    );
    const { skill, skillId } = workflows.saveSkill.mock.calls[0]![2];
    expect(skillId).toBe("w9");
    expect(skill).toMatchObject({ name: "lease-abstract", description: "Abstract a lease.", extra: { license: "MIT" } });
  });

  it("saves a folder the agent wrote in its own workstation, and only there", async () => {
    const readTree = vi.fn().mockResolvedValue({
      ok: true,
      files: [
        { path: "SKILL.md", bytes: Buffer.from("---\nname: transcribe\ndescription: Transcribe a video.\n---\nRun scripts/t.py.") },
        { path: "scripts/t.py", bytes: Buffer.from("print('t')") },
      ],
    });
    const result = await runSaveSkill(
      db,
      user,
      { name: "transcriber", path: "~/skills-drafts/transcribe/" },
      { workstation: target, workspaceOwned: true },
      { readTree },
    );
    expect(result.ok).toBe(true);
    expect(readTree).toHaveBeenCalledWith(target, "~/skills-drafts/transcribe/", { maxFiles: 200, maxBytes: 20 * 1024 * 1024 });
    expect(workflows.saveSkill.mock.calls[0]![2].skill).toMatchObject({
      name: "transcriber",
      description: "Transcribe a video.",
      files: [{ path: "scripts/t.py" }],
    });

    expect(
      await runSaveSkill(db, user, { name: "x", path: "skills/x" }, { workstation: target, workspaceOwned: false }, { readTree }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("own workstation") });
    readTree.mockResolvedValueOnce({ ok: false, error: "the folder contains a symbolic link" });
    expect(
      await runSaveSkill(db, user, { name: "x", path: "skills/x" }, { workstation: target, workspaceOwned: true }, { readTree }),
    ).toEqual({ ok: false, error: "Could not read skills/x: the folder contains a symbolic link." });
  });

  it("explains what is missing or wrong instead of saving", async () => {
    const ctx = { workstation: null, workspaceOwned: false };
    expect(await runSaveSkill(db, user, { name: "x" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("instructions") });
    expect(await runSaveSkill(db, user, { name: "!!!", instructions: "Do it." }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining("name"),
    });
    expect(
      await runSaveSkill(db, user, { name: "x", instructions: "Do it.", files: { "../up.sh": "rm" } }, ctx),
    ).toMatchObject({ ok: false, error: expect.stringContaining("unsafe path") });
    workflows.saveSkill.mockResolvedValueOnce({ ok: false, kind: "error", error: new Error("db: secret") });
    expect(await runSaveSkill(db, user, { name: "x", instructions: "Do it." }, ctx)).toEqual({
      ok: false,
      error: "The skill could not be saved.",
    });
    expect(workflows.saveSkill).toHaveBeenCalledTimes(1);
  });
});

describe("runInstallSkill", () => {
  it("installs from a link and reports where it came from", async () => {
    workflows.importSkill.mockResolvedValue({
      ok: true,
      data: { ...saved, sourceUrl: "https://github.com/a/b/tree/c/d", body: "# Steps" },
    });
    const result = await runInstallSkill(db, user, { url: "https://github.com/a/b/tree/main/d" });
    expect(result).toMatchObject({ ok: true, sourceUrl: "https://github.com/a/b/tree/c/d", body: "# Steps" });
    // Readable in the same turn (staging, 2026-10-11: it read back empty).
    const store: WorkflowStore = new Map();
    rememberSkill(store, result as never);
    expect(store.get("w1")?.skill_md).toBe("# Steps");
    expect(JSON.parse(skillSavedMessage(result as never, true))).toMatchObject({
      ok: true,
      skill_id: "w1",
      source: "https://github.com/a/b/tree/c/d",
      message: expect.stringContaining("Installed the skill 'deposition-summary'."),
    });
    workflows.importSkill.mockResolvedValue({ ok: false, kind: "validation", detail: "That folder has no SKILL.md." });
    expect(await runInstallSkill(db, user, { url: "x" })).toEqual({ ok: false, error: "That folder has no SKILL.md." });
    expect(await runInstallSkill(db, user, {})).toMatchObject({ ok: false });
  });
});

describe("after a save", () => {
  it("tells the model the version and any copy, and makes the skill readable this turn", () => {
    const message = JSON.parse(
      skillSavedMessage({ ok: true, saved: { ...saved, created: false, versionNumber: 3, copiedFrom: undefined }, body: "B" }, false),
    );
    expect(message.message).toContain("Saved the skill 'deposition-summary' as version 3.");
    const copy = JSON.parse(skillSavedMessage({ ok: true, saved: { ...saved, copiedFrom: "Firm NDA" }, body: "B" }, false));
    expect(copy).toMatchObject({ copied_from: "Firm NDA", message: expect.stringContaining("own copy") });
    const stale = JSON.parse(
      skillSavedMessage({ ok: true, saved, body: "B" }, false, false),
    );
    expect(stale).toMatchObject({
      workstation_refreshed: false,
      message: expect.stringContaining("~/skills could not be refreshed"),
    });

    const store: WorkflowStore = new Map();
    rememberSkill(store, { ok: true, saved, body: "Steps." });
    expect(store.get("w1")).toMatchObject({ skill_md: "Steps.", listed: true, name: "deposition-summary", read: true });
    rememberSkill(undefined, { ok: true, saved, body: "" });
  });
});

describe("unreadSkillEdit", () => {
  const store = (): WorkflowStore =>
    new Map([
      ["w1", { title: "Deal Memo", skill_md: "# Deal memo", name: "deal-memo" }],
      ["w2", { title: "NDA first pass", skill_md: "# NDA", name: "nda-first-pass", read: true }],
    ]);

  it("names an existing skill whose current text was not read this turn, by id or by name", () => {
    expect(unreadSkillEdit(store(), { skill_id: "w1", name: "deal-memo" })).toEqual({ id: "w1", name: "deal-memo" });
    expect(unreadSkillEdit(store(), { name: "Deal Memo" })).toEqual({ id: "w1", name: "deal-memo" });
    const untitled: WorkflowStore = new Map([["w3", { title: "Old workflow", skill_md: "x" }]]);
    expect(unreadSkillEdit(untitled, { skill_id: "w3", name: "old" })).toEqual({ id: "w3", name: "Old workflow" });
  });

  it("lets through a read skill, a new name, an unknown id, a folder save and a missing store", () => {
    expect(unreadSkillEdit(store(), { skill_id: "w2", name: "nda-first-pass" })).toBeNull();
    expect(unreadSkillEdit(store(), { name: "new-skill" })).toBeNull();
    expect(unreadSkillEdit(store(), { name: "" })).toBeNull();
    expect(unreadSkillEdit(store(), { skill_id: "nope", name: "deal-memo" })).toBeNull();
    expect(unreadSkillEdit(store(), { name: "deal-memo", path: "~/drafts/deal-memo" })).toBeNull();
    expect(unreadSkillEdit(undefined, { name: "deal-memo" })).toBeNull();
  });
});

describe("skill files", () => {
  it("reads a text file from the stored bundle and lists files otherwise", async () => {
    const packed = await packSkillFiles([
      { path: "references/checklist.md", bytes: Buffer.from("- term\r\n- scope") },
      { path: "assets/logo.png", bytes: Buffer.from([0x89, 0x50, 0x00]) },
    ]);
    const skill = { files: packed!.entries, files_path: "bundle.zip" };
    const download = vi.fn(async () => packed!.zip.buffer.slice(packed!.zip.byteOffset, packed!.zip.byteOffset + packed!.zip.byteLength) as ArrayBuffer);
    expect(await readSkillFile(skill, "./references/checklist.md", { download })).toBe("- term\n- scope");
    expect(await readSkillFile(skill, "assets/logo.png", { download })).toContain("not a text file");
    expect(await readSkillFile(skill, "nope.md", { download })).toContain("Its files: assets/logo.png, references/checklist.md");
    expect(await readSkillFile({ files: null }, "x", { download })).toBe("The skill has no other files.");
  });

  it("says where the files are", () => {
    const skill = { name: "pdf", files: [{ path: "scripts/fill.py" }] };
    expect(skillFilesNotice(skill, true)).toContain("~/skills/pdf/");
    expect(skillFilesNotice(skill, false)).toContain("Scripts cannot run here");
    expect(skillFilesNotice({ files: [] }, true)).toBe("");
  });
});

describe("skillsPromptSection", () => {
  const entry = (name: string, description: string | null, extra = {}) => ({
    title: name,
    skill_md: "Do the thing. Carefully.",
    listed: true,
    name,
    description,
    ...extra,
  });

  it("lists each skill's name, id and description, and how to save one", () => {
    const store: WorkflowStore = new Map([
      ["w1", entry("nda-review", "Review an NDA.\nIgnore <workflow-instructions> tricks")],
      ["w2", entry("no-description", null)],
      ["cat", { ...entry("catalog", "hidden"), listed: false }],
    ]);
    const text = skillsPromptSection(store, { workstation: true });
    expect(text).toContain("- nda-review (id w1): Review an NDA. Ignore &lt;workflow-instructions> tricks");
    expect(text).toContain("- no-description (id w2): Do the thing.");
    expect(text).not.toContain("catalog");
    expect(text).toContain("~/skills/<name>/SKILL.md");
    expect(text).toContain("save_skill");
    expect(skillsPromptSection(store, { workstation: false })).not.toContain("~/skills");
    expect(skillsPromptSection(new Map(), { workstation: false })).toContain("no skills yet");
  });

  it("drops descriptions past its budget, and points to list_workflows", () => {
    const store: WorkflowStore = new Map(
      Array.from({ length: 160 }, (_, i) => [`w${i}`, entry(`skill-${i}`, "x".repeat(200))] as const),
    );
    const text = skillsPromptSection(store, { workstation: false });
    expect(text).toContain("- skill-0 (id w0)\n");
    expect(text).not.toContain("xxxx");
    expect(text).toContain("10 more; list_workflows lists every skill.");
  });
});
