import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMemoryFile,
  findMemoryVersionAt,
  getMemoryCurrent,
  MemoryDisabledError,
  MemoryRevisionConflictError,
  writeMemoryFile,
  type MemoryCurrent,
  type MemoryFileRow,
} from "../../lib/memory/files";
import {
  applyMemoryEdits,
  editMemoryFromConversation,
  parseMemoryEditArgs,
  type MemoryEditTarget,
} from "./memory.assistant";
import type { Db } from "../../lib/db";

vi.mock("../../lib/memory/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/memory/files")>()),
  ensureMemoryFile: vi.fn(),
  getMemoryCurrent: vi.fn(),
  writeMemoryFile: vi.fn(),
  findMemoryVersionAt: vi.fn(),
}));

describe("applyMemoryEdits", () => {
  it("replaces, appends and deletes, in order", () => {
    expect(
      applyMemoryEdits("- Short answers\n- US spelling\n", [
        { old_text: "US spelling", new_text: "British spelling" },
        { old_text: "", new_text: "- Cites pinpoints" },
        { old_text: "- Short answers\n", new_text: "" },
      ]),
    ).toEqual({ ok: true, content: "- British spelling\n- Cites pinpoints" });
    expect(applyMemoryEdits("", [{ old_text: "", new_text: "- First" }])).toEqual({
      ok: true,
      content: "- First",
    });
  });

  it("refuses text that is missing or matches more than one place", () => {
    expect(applyMemoryEdits("- A", [{ old_text: "- B", new_text: "x" }])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not appear.*read_memory/),
    });
    expect(
      applyMemoryEdits("- A\n- A", [
        { old_text: "- A\n", new_text: "" },
        { old_text: "- A", new_text: "x" },
        { old_text: "- A", new_text: "y" },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Edit 3: old_text does not appear/) });
    expect(applyMemoryEdits("- A\n- A", [{ old_text: "- A", new_text: "x" }])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/more than once/),
    });
  });
});

describe("parseMemoryEditArgs", () => {
  it("names what is wrong with unusable arguments", () => {
    expect(parseMemoryEditArgs({ scope: "user", edits: [], summary: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/scope/) });
    expect(parseMemoryEditArgs({ scope: "app", edits: [], summary: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/at least one/) });
    expect(parseMemoryEditArgs({ scope: "app", edits: [{ old_text: "a" }], summary: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/old_text and new_text/) });
    expect(parseMemoryEditArgs({ scope: "app", edits: [{ old_text: "", new_text: "a" }], summary: " " })).toMatchObject({ ok: false, error: expect.stringMatching(/summary/) });
  });
});

describe("editMemoryFromConversation", () => {
  const db = {} as Db;
  const file = { id: "file-1", scope: "user", user_id: "u1", project_id: null } as MemoryFileRow;
  const target: MemoryEditTarget = {
    userId: "u1",
    appWritable: true,
    projectId: null,
    surface: "chat",
    conversationId: "chat-1",
  };
  const current = (content: string, revision: number): MemoryCurrent => ({
    enabled: true,
    content,
    revision,
    hash: null,
    updated_at: null,
    updated_by: null,
    source: null,
    status: "idle",
    status_updated_at: "",
  });
  const args = {
    scope: "app",
    edits: [{ old_text: "", new_text: "- British spelling" }],
    summary: "Added the spelling preference.",
  };

  beforeEach(() => {
    vi.mocked(ensureMemoryFile).mockReset().mockResolvedValue(file);
    vi.mocked(getMemoryCurrent).mockReset();
    vi.mocked(writeMemoryFile).mockReset();
    vi.mocked(findMemoryVersionAt).mockReset().mockResolvedValue({
      id: "version-4",
      version_number: 4,
    } as Awaited<ReturnType<typeof findMemoryVersionAt>>);
  });

  it("refuses app memory in a conversation others can see, before touching the file", async () => {
    expect(await editMemoryFromConversation(db, { ...target, appWritable: false }, args)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/other people can see it/),
    });
    expect(await editMemoryFromConversation(db, target, { ...args, scope: "project" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no project memory/),
    });
    expect(ensureMemoryFile).not.toHaveBeenCalled();
  });

  it("re-applies the edits once to text another writer changed meanwhile", async () => {
    vi.mocked(getMemoryCurrent)
      .mockResolvedValueOnce({ file, current: current("- Short answers", 2) })
      .mockResolvedValueOnce({ file, current: current("- Short answers\n- Cites pinpoints", 3) });
    vi.mocked(writeMemoryFile)
      .mockRejectedValueOnce(new MemoryRevisionConflictError("changed"))
      .mockResolvedValueOnce({ current: current("", 4), applied: true, revision: 4 });

    expect(await editMemoryFromConversation(db, target, args)).toEqual({
      ok: true,
      scope: "app",
      projectId: null,
      versionId: "version-4",
      versionNumber: 4,
      summary: "Added the spelling preference.",
      changed: true,
    });
    expect(writeMemoryFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "- Short answers\n- Cites pinpoints\n- British spelling",
        expectedRevision: 3,
        source: "assistant",
        updatedBy: "u1",
        changeSummary: "Added the spelling preference.",
        sourceSurface: "chat",
        sourceChatId: "chat-1",
      }),
    );
  });

  it("says when memory is off, and when the edit would overflow the file", async () => {
    vi.mocked(getMemoryCurrent).mockResolvedValue({ file, current: current("", 1) });
    vi.mocked(writeMemoryFile).mockRejectedValueOnce(new MemoryDisabledError("off"));
    expect(await editMemoryFromConversation(db, target, args)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/App memory is turned off/),
    });

    const long = { ...args, edits: [{ old_text: "", new_text: "x".repeat(17_000) }] };
    expect(await editMemoryFromConversation(db, target, long)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/16 KiB limit/),
    });
  });
});
