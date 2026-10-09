import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../../../__tests__/helpers/scriptedDb";
import type { Db } from "../../../../../lib/db";
const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  apply: vi.fn(),
  gate: vi.fn(),
  saveBlockIds: vi.fn(),
}));
vi.mock("../../../../documents/documents.service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  docxViewForVersion: vi.fn(async () => ({ blocks: [] })),
  saveBlockIds: mocks.saveBlockIds,
}));
vi.mock("../../../../../lib/documentVersions", () => ({
  loadActiveVersion: mocks.active,
  contentSha256: () => "hash",
}));
vi.mock("../../../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));
vi.mock("../../../../../lib/docxTrackedChanges", () => ({
  extractDocxBodyText: vi.fn(),
}));
vi.mock("../../../../../lib/docx/edit", () => ({ applyEdits: mocks.apply }));
vi.mock("../../../../../lib/docx/gate", () => ({ checkEditedDocx: mocks.gate }));
vi.mock("../../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: (path: string, filename: string) =>
    `download:${filename}:${path}`,
}));
import { runEditDocument } from "../documentOps";
const change = {
  id: "change",
  delId: "del",
  insId: "ins",
  deletedText: "old",
  insertedText: "new",
  contextBefore: "before",
  contextAfter: "after",
  reason: "clarify",
  revisionIds: ["del", "ins", "mark"],
};
const editRow = {
  id: "edit",
  change_id: "change",
  deleted_text: "old",
  inserted_text: "new",
  context_before: "before",
  context_after: "after",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DB_JOBS_ENABLED", "true");
  vi.stubEnv("QUEUE_DRIVER", "postgres");
  mocks.active.mockResolvedValue({
    id: "active",
    filename: "Renamed.docx",
    storage_path: "current",
  });
  mocks.downloadFile.mockResolvedValue(new ArrayBuffer(4));
  mocks.apply.mockResolvedValue({
    ok: true,
    bytes: Buffer.from("edited"),
    changes: [change],
    splitRevisions: [],
    blockIds: ["p1", "p1+1"],
  });
  mocks.gate.mockResolvedValue({ ok: true });
});
const initial = () => [
  { table: "documents", data: { id: "doc" } },
  { table: "user_profiles", data: { display_name: "Author" } },
];
function newVersionDb(
  options: {
    editsFail?: boolean;
    createFail?: boolean;
    activation?: boolean;
  } = {},
) {
  const fake = scriptedDb([
    ...initial(),
    { table: "document_versions", data: { filename: "Renamed.docx" } },
    ...(!options.createFail
      ? [
          {
            table: "document_edits",
            op: "insert",
            data: options.editsFail ? null : [editRow],
            error: options.editsFail ? { message: "edit insert failed" } : null,
          },
        ]
      : []),
  ]);
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "create_document_version") {
      expect(fake.calls.some((call) => call.table === "document_edits")).toBe(
        false,
      );
      expect(params.p_activate).toBe(false);
      return options.createFail
        ? { data: null, error: { message: "version insert failed" } }
        : { data: { id: "version", version_number: 9 }, error: null };
    }
    expect(name).toBe("activate_document_version");
    expect(fake.calls.at(-1)?.table).toBe("document_edits");
    return { data: options.activation !== false, error: null };
  });
  const db = { ...fake.db, rpc } as unknown as Db;
  return { ...fake, db, rpc };
}
const run = (
  db: Db,
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  },
) =>
  runEditDocument({
    db,
    documentId: "doc",
    userId: "actor",
    edits: [],
    reuseVersion,
  });
describe("assistant document-edit lifecycle", () => {
  it("saves edit rows before activation and returns annotations with the allocated version and inherited filename", async () => {
    const fake = newVersionDb();
    const result = await run(fake.db);
    expect(result).toMatchObject({
      ok: true,
      version_id: "version",
      version_number: 9,
      errors: [],
      annotations: [
        {
          kind: "edit",
          edit_id: "edit",
          document_id: "doc",
          version_id: "version",
          version_number: 9,
          deleted_text: "old",
          inserted_text: "new",
          reason: "clarify",
          status: "pending",
        },
      ],
    });
    if (result.ok) expect(result.download_url).toContain("Renamed.docx");
    expect(fake.rpc.mock.calls[0][1].p_version).not.toHaveProperty(
      "version_number",
    );
    expect(
      fake.calls.find((call) => call.table === "document_edits")?.payload,
    ).toEqual([
      expect.objectContaining({
        document_id: "doc",
        version_id: "version",
        change_id: "change",
        del_w_id: "del",
        ins_w_id: "ins",
        w_ids: ["del", "ins", "mark"],
      }),
    ]);
    // The new version stores the block ids carried from the one it was edited from.
    expect(mocks.saveBlockIds).toHaveBeenCalledWith(fake.db, "doc", "version", Buffer.from("edited"), ["p1", "p1+1"]);
    fake.done();
  });
  it("gives an earlier card the new id when an edit splits its insertion", async () => {
    mocks.apply.mockResolvedValue({
      ok: true,
      bytes: Buffer.from("edited"),
      changes: [change],
      splitRevisions: [{ from: "7", to: "99" }],
      blockIds: [],
    });
    const fake = scriptedDb([
      ...initial(),
      { table: "document_versions", data: { filename: "Renamed.docx" } },
      { table: "document_edits", op: "insert", data: [editRow] },
      {
        table: "document_edits",
        data: [
          { id: "earlier", del_w_id: null, ins_w_id: "7", w_ids: ["7"] },
          { id: "unrelated", del_w_id: "3", ins_w_id: null, w_ids: ["3"] },
        ],
      },
      { table: "document_edits", op: "update" },
    ]);
    const rpc = vi.fn(async (name: string) =>
      name === "create_document_version" ? { data: { id: "version", version_number: 9 }, error: null } : { data: true, error: null },
    );
    expect((await run({ ...fake.db, rpc } as unknown as Db)).ok).toBe(true);
    const update = fake.calls.find((c) => c.table === "document_edits" && c.op === "update")!;
    expect(update.payload).toEqual({ w_ids: ["7", "99"] });
    expect(update.filters).toContainEqual(["eq", "id", "earlier"]);
    fake.done();
  });

  it("changes nothing when an edit fails, and lists every failure", async () => {
    mocks.apply.mockResolvedValue({
      ok: false,
      errors: [
        { index: 0, error: "Unknown block id \"x\"." },
        { index: 2, error: "Could not find \"y\"." },
      ],
    });
    const fake = scriptedDb(initial());
    const rpc = vi.fn();
    expect(await run({ ...fake.db, rpc } as unknown as Db)).toEqual({
      ok: false,
      error: 'No changes were made.\nEdit 1: Unknown block id "x".\nEdit 3: Could not find "y".',
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    fake.done();
  });
  it("creates no version when the edited document fails the gate", async () => {
    mocks.gate.mockResolvedValue({ ok: false, problems: ["Table without rows"] });
    const fake = scriptedDb(initial());
    const rpc = vi.fn();
    const result = await run({ ...fake.db, rpc } as unknown as Db);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^No changes were made: the edited document failed validation/) });
    expect(mocks.gate).toHaveBeenCalledWith(expect.any(Buffer), Buffer.from("edited"));
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    fake.done();
  });
  it("does not activate a new version if saving its edits fails", async () => {
    const fake = newVersionDb({ editsFail: true });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to record edits.",
    });
    expect(fake.rpc.mock.calls.map((call) => call[0])).toEqual([
      "create_document_version",
    ]);
    fake.done();
  });
  it("reports insertion failure without persisting edits or activating", async () => {
    const fake = newVersionDb({ createFail: true });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to record document version.",
    });
    expect(fake.rpc).toHaveBeenCalledOnce();
    fake.done();
  });
  it("does not report success if the target was deleted before activation", async () => {
    const fake = newVersionDb({ activation: false });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to activate document version.",
    });
    fake.done();
  });
  it("reuses the same turn's version and appends edits without allocating another version", async () => {
    const fake = scriptedDb([
      ...initial(),
      { table: "document_versions", op: "update", data: { id: "reused" } },
      { table: "document_versions", op: "update", data: { id: "reused" } },
      { table: "document_edits", op: "insert", data: [editRow] },
    ]);
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    mocks.uploadFile.mockImplementation(async () => {
      expect(fake.calls.at(-1)?.payload).toEqual({ content_sha256: null });
    });
    const result = await run({ ...fake.db, rpc } as unknown as Db, {
      versionId: "reused",
      versionNumber: 7,
      storagePath: "same-turn",
    });
    expect(result).toMatchObject({
      ok: true,
      version_id: "reused",
      version_number: 7,
      storage_path: "same-turn",
      annotations: [{ version_id: "reused", version_number: 7 }],
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("activate_document_version", {
      p_document_id: "doc",
      p_version_id: "reused",
    });
    expect(fake.calls[3].payload).toMatchObject({
      content_sha256: "hash",
      pdf_storage_path: null,
    });
    fake.done();
  });
  it("does not overwrite a deleted same-turn version", async () => {
    const fake = scriptedDb([
      ...initial(),
      { table: "document_versions", op: "update", data: null },
    ]);
    expect(
      await run(fake.db, {
        versionId: "gone",
        versionNumber: 7,
        storagePath: "same-turn",
      }),
    ).toEqual({ ok: false, error: "Document version is unavailable." });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    fake.done();
  });
});
