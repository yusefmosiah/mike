import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../../lib/db";
import { skillFromParts } from "../../../lib/skillFormat";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const storage = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFilesBestEffort: vi.fn(),
}));
vi.mock("../../../lib/storage", () => storage);

const access = vi.hoisted(() => ({ resolveWorkflowAccess: vi.fn() }));
vi.mock("../workflows.access", () => access);

import {
  listSkillVersions,
  listWorkstationSkills,
  restoreSkillVersion,
  saveSkill,
  skillMdOf,
  skillNameOf,
} from "../workflows.skills";

const user = { id: "u1", email: "Owner@Example.com" };
const skill = (fields: Partial<Parameters<typeof skillFromParts>[0]> = {}) =>
  skillFromParts({ name: "contract-review", description: "Review a contract.", body: "1. Read it.", ...fields });
const snapshot = { title: "contract-review", description: "Review a contract.", prompt_md: "1. Read it." };

beforeEach(() => vi.clearAllMocks());

describe("saveSkill", () => {
  it("creates a skill with its files zipped in storage and records version 1", async () => {
    const fake = scriptedDb([
      { table: "workflows", data: [] },
      { table: "workflows", op: "insert", data: { id: "w1" } },
      { table: "workflows", data: snapshot },
      { table: "workflow_versions", data: [] },
      { table: "workflow_versions", op: "insert" },
    ]);
    const result = await saveSkill(fake.db as unknown as Db, user, {
      skill: skill({ files: [{ path: "scripts/check.py", bytes: Buffer.from("print(1)") }] }),
      source: "chat",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { skillId: "w1", name: "contract-review", versionNumber: 1, created: true, files: [{ path: "scripts/check.py", size: 8 }] },
    });
    expect(storage.uploadFile).toHaveBeenCalledWith(expect.stringMatching(/^skills\/u1\/.+\.zip$/), expect.any(ArrayBuffer), "application/zip");
    const insert = fake.calls[1]!.payload as Record<string, unknown>;
    expect(insert).toMatchObject({
      user_id: "u1",
      title: "contract-review",
      type: "assistant",
      description: "Review a contract.",
      prompt_md: "1. Read it.",
      files: [{ path: "scripts/check.py", size: 8 }],
      source_url: null,
    });
    expect(fake.calls[4]!.payload).toMatchObject({ workflow_id: "w1", version_number: 1, source: "chat", created_by: "u1" });
  });

  it("versions the user's own skill of the same name, recording what it was first", async () => {
    const fake = scriptedDb([
      { table: "workflows", data: [{ id: "w0", title: "Contract Review" }] },
      // No versions yet: the existing state becomes version 1.
      { table: "workflow_versions", data: [] },
      { table: "workflows", data: { ...snapshot, title: "Contract Review", prompt_md: "old" } },
      { table: "workflow_versions", data: [] },
      { table: "workflow_versions", op: "insert" },
      { table: "workflows", op: "update", data: { id: "w0" } },
      { table: "workflows", data: snapshot },
      { table: "workflow_versions", data: [{ version_number: 1 }] },
      { table: "workflow_versions", op: "insert" },
    ]);
    const result = await saveSkill(fake.db as unknown as Db, user, { skill: skill(), source: "chat" });

    expect(result).toMatchObject({ ok: true, data: { skillId: "w0", versionNumber: 2, created: false, title: "Contract Review" } });
    expect(fake.calls[4]!.payload).toMatchObject({ version_number: 1, source: "original", prompt_md: "old" });
    // The legacy title stays; the body and description change.
    expect(fake.calls[5]!.payload).toMatchObject({ title: "Contract Review", prompt_md: "1. Read it.", files: null });
    expect(fake.calls[5]!.payload).not.toHaveProperty("source_url");
    expect(fake.calls[8]!.payload).toMatchObject({ version_number: 2, source: "chat" });
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("saves a copy of a skill the user can only read, and refuses one they cannot see", async () => {
    access.resolveWorkflowAccess.mockResolvedValueOnce({
      workflow: { id: "shared", title: "Firm NDA", type: "assistant" },
      allowEdit: false,
    });
    const fake = scriptedDb([
      { table: "workflows", op: "insert", data: { id: "mine" } },
      { table: "workflows", data: snapshot },
      { table: "workflow_versions", data: [] },
      { table: "workflow_versions", op: "insert" },
    ]);
    const result = await saveSkill(fake.db as unknown as Db, user, { skill: skill(), skillId: "shared", source: "chat" });
    expect(result).toMatchObject({ ok: true, data: { skillId: "mine", created: true, copiedFrom: "Firm NDA" } });

    access.resolveWorkflowAccess.mockResolvedValueOnce(null);
    expect(await saveSkill(scriptedDb([]).db as unknown as Db, user, { skill: skill(), skillId: "x", source: "chat" })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("records an import's source and takes the next number when two saves race", async () => {
    access.resolveWorkflowAccess.mockResolvedValueOnce({
      workflow: { id: "w1", title: "pdf", type: "assistant" },
      allowEdit: true,
    });
    const fake = scriptedDb([
      { table: "workflow_versions", data: [{ id: "v1" }] },
      { table: "workflows", op: "update", data: { id: "w1" } },
      { table: "workflows", data: snapshot },
      { table: "workflow_versions", data: [{ version_number: 3 }] },
      { table: "workflow_versions", op: "insert", error: { code: "23505" } },
      { table: "workflow_versions", data: [{ version_number: 4 }] },
      { table: "workflow_versions", op: "insert" },
    ]);
    const result = await saveSkill(fake.db as unknown as Db, user, {
      skill: skill({ name: "pdf" }),
      skillId: "w1",
      source: "import",
      sourceUrl: "https://github.com/acme/skills/tree/abc/pdf",
    });
    expect(result).toMatchObject({ ok: true, data: { versionNumber: 5, created: false } });
    expect(fake.calls[1]!.payload).toMatchObject({ source_url: "https://github.com/acme/skills/tree/abc/pdf" });
  });
});

describe("versions", () => {
  it("lists versions for anyone who can read the skill", async () => {
    access.resolveWorkflowAccess.mockResolvedValueOnce({ workflow: { id: "w1" }, allowEdit: false });
    const fake = scriptedDb([{ table: "workflow_versions", data: [{ id: "v2", version_number: 2 }] }]);
    expect(await listSkillVersions(fake.db as unknown as Db, user, "w1")).toEqual({
      ok: true,
      data: [{ id: "v2", version_number: 2 }],
    });
    access.resolveWorkflowAccess.mockResolvedValueOnce(null);
    expect(await listSkillVersions(fake.db as unknown as Db, user, "w1")).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("restores an earlier version as a new one, for editors only", async () => {
    access.resolveWorkflowAccess.mockResolvedValueOnce({ workflow: { id: "w1" }, allowEdit: true });
    const fake = scriptedDb([
      { table: "workflow_versions", data: { ...snapshot, prompt_md: "v1 body" } },
      { table: "workflows", op: "update", data: { id: "w1" } },
      { table: "workflows", data: snapshot },
      { table: "workflow_versions", data: [{ version_number: 2 }] },
      { table: "workflow_versions", op: "insert" },
    ]);
    expect(await restoreSkillVersion(fake.db as unknown as Db, user, "w1", "v1")).toEqual({ ok: true, data: { versionNumber: 3 } });
    expect(fake.calls[0]!.filters).toEqual(expect.arrayContaining([["eq", "id", "v1"], ["eq", "workflow_id", "w1"]]));
    expect(fake.calls[1]!.payload).toMatchObject({ prompt_md: "v1 body" });
    expect(fake.calls[4]!.payload).toMatchObject({ source: "restore" });

    access.resolveWorkflowAccess.mockResolvedValueOnce({ workflow: { id: "w1" }, allowEdit: false });
    expect(await restoreSkillVersion(scriptedDb([]).db as unknown as Db, user, "w1", "v1")).toMatchObject({
      ok: false,
      kind: "forbidden",
    });
  });
});

describe("the workstation's skills", () => {
  it("renders SKILL.md from the row", () => {
    const row = { id: "w", user_id: null, title: "Contract Review", description: null, prompt_md: "Steps.", frontmatter: { license: "MIT" } };
    expect(skillNameOf(row)).toBe("contract-review");
    expect(skillMdOf(row)).toBe("---\nname: contract-review\ndescription: Contract Review\nlicense: MIT\n---\n\nSteps.\n");
    expect(skillNameOf({ title: "!!!" })).toBe("skill");
  });

  it("lists own and shared skills, oldest first, skipping empty ones", async () => {
    const fake = scriptedDb([
      {
        table: "workflows",
        data: [
          { id: "b", title: "Second", prompt_md: "B.", created_at: "2026-02-01" },
          { id: "e", title: "Empty", prompt_md: "", created_at: "2026-01-15" },
        ],
      },
      { table: "workflow_shares", data: [{ workflow_id: "a" }, { workflow_id: "b" }] },
      { table: "workflows", data: [{ id: "a", title: "First", prompt_md: "A.", files: [{ path: "x.py", size: 1 }], files_path: "k", created_at: "2026-01-01" }] },
    ]);
    const skills = await listWorkstationSkills(fake.db as unknown as Db, user);
    expect(skills.map((s) => [s.name, s.files.length, s.filesPath])).toEqual([
      ["first", 1, "k"],
      ["second", 0, null],
    ]);
    expect(fake.calls[1]!.filters).toEqual([["eq", "shared_with_email", "owner@example.com"]]);
    expect(fake.calls[2]!.filters).toEqual(expect.arrayContaining([["in", "id", ["a"]]]));
  });
});
