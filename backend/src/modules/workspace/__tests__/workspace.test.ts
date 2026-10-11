import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../../lib/db";
import type { WorkstationTarget } from "../../../lib/workstation";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
  listAccessibleProjectIds: vi.fn(),
  checkProjectAccess: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);

const documents = vi.hoisted(() => ({
  ensureDocumentAccess: vi.fn(),
  storeDocumentFile: vi.fn(),
}));
vi.mock("../../documents/documents.service", () => documents);

import {
  buildWorkspaceView,
  safeSegment,
  saveToMike,
  syncWorkspace,
  syncWorkspaceOncePerTurn,
  uniqueName,
  workspaceRelative,
  type WorkspaceFile,
  type WorkspaceView,
} from "../workspace.service";

const target: WorkstationTarget = { host: "vm", user: "agent", identityFile: "/keys/dev" };
const user = { id: "u1", email: "owner@example.com" };
const db = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("path names", () => {
  it("makes one readable path segment", () => {
    expect(safeSegment("Q3/Q4 plan\\draft")).toBe("Q3_Q4 plan_draft");
    expect(safeSegment("  many   spaces  ")).toBe("many spaces");
    expect(safeSegment("line\nbreak")).toBe("line_break");
    expect(safeSegment("..")).toBe("_");
    expect(safeSegment("", "folder")).toBe("folder");
    expect(safeSegment(null)).toBe("untitled");
    expect(Buffer.byteLength(safeSegment("é".repeat(200)), "utf8")).toBeLessThanOrEqual(240);
  });

  it("numbers clashes case-insensitively, keeping the extension", () => {
    const taken = new Set<string>();
    expect(uniqueName("Lease.docx", taken)).toBe("Lease.docx");
    expect(uniqueName("lease.docx", taken)).toBe("lease (2).docx");
    expect(uniqueName("Lease.docx", taken)).toBe("Lease (3).docx");
    expect(uniqueName("README", taken)).toBe("README");
    expect(uniqueName("README", taken)).toBe("README (2)");
  });

  it("finds a path under ~/mike however the agent spells it", () => {
    expect(workspaceRelative("/home/agent/mike/projects/A/x.docx")).toBe("projects/A/x.docx");
    expect(workspaceRelative("~/mike/library/n.md")).toBe("library/n.md");
    expect(workspaceRelative("mike/templates/t.docx")).toBe("templates/t.docx");
    expect(workspaceRelative("~/mike/../.ssh/id")).toBeNull();
    expect(workspaceRelative("~/mike")).toBeNull();
    expect(workspaceRelative("/etc/passwd")).toBeNull();
  });
});

describe("buildWorkspaceView", () => {
  it("lays out projects, folders, the library and templates, numbering clashes in creation order", async () => {
    access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
    const doc = (id: string, fields: Record<string, unknown>, created: string) => ({
      id,
      project_id: null,
      folder_id: null,
      library_kind: null,
      library_folder_id: null,
      current_version_id: `v-${id}`,
      created_at: created,
      ...fields,
    });
    const version = (id: string, filename: string, fields: Record<string, unknown> = {}) => ({
      id: `v-${id}`,
      filename,
      file_type: filename.split(".").pop(),
      storage_path: `store/${id}`,
      size_bytes: 10,
      deleted_at: null,
      ...fields,
    });
    const fake = scriptedDb([
      {
        table: "projects",
        data: [
          { id: "p2", name: "acme", created_at: "2026-02-01" },
          { id: "p1", name: "Acme", created_at: "2026-01-01" },
        ],
      },
      {
        table: "project_subfolders",
        data: [
          { id: "f1", name: "Contracts", parent_folder_id: null },
          { id: "f2", name: "Signed", parent_folder_id: "f1" },
        ],
      },
      { table: "library_folders", data: [{ id: "lf", name: "Research", parent_folder_id: null }] },
      {
        table: "documents",
        data: [
          doc("d1", { project_id: "p1", folder_id: "f2" }, "2026-03-01"),
          doc("d2", { project_id: "p1", folder_id: "f2" }, "2026-03-02"),
          doc("d3", { project_id: "p2" }, "2026-03-03"),
          doc("gone", { project_id: "p2" }, "2026-03-04"),
          doc("nover", { project_id: "p2", current_version_id: null }, "2026-03-05"),
        ],
      },
      {
        table: "documents",
        data: [
          doc("d4", { library_kind: "file", library_folder_id: "lf" }, "2026-03-06"),
          doc("d5", { library_kind: "template" }, "2026-03-07"),
          doc("asset", { library_kind: "workflow_asset" }, "2026-03-08"),
        ],
      },
      {
        table: "document_versions",
        data: [
          version("d1", "Lease.docx"),
          version("d2", "lease.docx"),
          version("d3", "Memo.pdf"),
          version("gone", "Old.pdf", { deleted_at: "2026-04-01" }),
          version("d4", "notes.md"),
          version("d5", "NDA.docx"),
        ],
      },
    ]);

    const view = await buildWorkspaceView(fake.db as unknown as Db, user);
    expect([...view.keys()]).toEqual([
      "projects/Acme/Contracts/Signed/Lease.docx",
      "projects/Acme/Contracts/Signed/lease (2).docx",
      "projects/acme (2)/Memo.pdf",
      "library/Research/notes.md",
      "templates/NDA.docx",
    ]);
    expect(view.get("templates/NDA.docx")).toEqual({
      documentId: "d5",
      versionId: "v-d5",
      projectId: null,
      storagePath: "store/d5",
      fileType: "docx",
      sizeBytes: 10,
    });
    // The library is only the user's own documents outside projects and workflows.
    const library = fake.calls.filter((call) => call.table === "documents")[1]!;
    expect(library.filters).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", "u1"],
        ["is", "project_id", null],
        ["is", "workflow_id", null],
        ["eq", "status", "ready"],
      ]),
    );
  });
});

const file = (versionId: string, storagePath = `store/${versionId}`): WorkspaceFile => ({
  documentId: `doc-${versionId}`,
  versionId,
  projectId: null,
  storagePath,
  fileType: "txt",
  sizeBytes: null,
});

describe("syncWorkspace", () => {
  it("writes only new and changed files, and removes what the user can no longer read", async () => {
    const view: WorkspaceView = new Map([
      ["library/same.txt", file("v1")],
      ["library/changed.txt", file("v2b")],
      ["library/new.txt", file("v3")],
      ["library/missing.txt", file("v4")],
    ]);
    const writeBatch = vi.fn().mockResolvedValue({ ok: true });
    const download = vi.fn(async (storagePath: string) =>
      storagePath === "store/v4" ? null : new TextEncoder().encode(`bytes of ${storagePath}`).buffer as ArrayBuffer,
    );
    const result = await syncWorkspace(db, user, target, {
      buildView: async () => view,
      readManifest: async () => ({
        ok: true,
        files: {
          "library/same.txt": { version: "v1", size: 5 },
          "library/changed.txt": { version: "v2a", size: 5 },
          "projects/Revoked/x.txt": { version: "v9", size: 5 },
        },
      }),
      writeBatch,
      download,
    });

    expect(result).toMatchObject({ ok: true, files: 3, written: 2, deleted: 2, skipped: 1 });
    expect(download).not.toHaveBeenCalledWith("store/v1");
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const batch = writeBatch.mock.calls[0]![1];
    expect(batch.delete).toEqual(["library/changed.txt", "projects/Revoked/x.txt"]);
    expect(batch.files.map((f: { path: string }) => f.path)).toEqual(["library/changed.txt", "library/new.txt"]);
    expect(batch.manifest).toEqual({
      "library/same.txt": { version: "v1", size: 5 },
      "library/changed.txt": { version: "v2b", size: "bytes of store/v2b".length },
      "library/new.txt": { version: "v3", size: "bytes of store/v3".length },
    });
  });

  it("does nothing when the workstation is already current", async () => {
    const writeBatch = vi.fn();
    const result = await syncWorkspace(db, user, target, {
      buildView: async () => new Map([["library/a.txt", file("v1")]]),
      readManifest: async () => ({ ok: true, files: { "library/a.txt": { version: "v1", size: 3 } } }),
      writeBatch,
      download: vi.fn(),
    });
    expect(result).toMatchObject({ ok: true, files: 1, written: 0, deleted: 0 });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("splits a large sync into sessions of about 64 MB, each with the manifest so far", async () => {
    const big = 40 * 1024 * 1024;
    const view: WorkspaceView = new Map([
      ["library/a.bin", file("a")],
      ["library/b.bin", file("b")],
      ["library/c.bin", file("c")],
    ]);
    const writeBatch = vi.fn().mockResolvedValue({ ok: true });
    await syncWorkspace(db, user, target, {
      buildView: async () => view,
      readManifest: async () => ({ ok: true, files: {} }),
      writeBatch,
      download: async () => new ArrayBuffer(big),
    });
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(writeBatch.mock.calls.map((call) => call[1].files.length)).toEqual([2, 1]);
    expect(Object.keys(writeBatch.mock.calls[0]![1].manifest)).toEqual(["library/a.bin", "library/b.bin"]);
    expect(Object.keys(writeBatch.mock.calls[1]![1].manifest)).toHaveLength(3);
  });

  it("reports a workstation that cannot be read or written", async () => {
    const base = { buildView: async () => new Map([["library/a.txt", file("v1")]]), download: async () => new ArrayBuffer(1) };
    expect(
      await syncWorkspace(db, user, target, { ...base, readManifest: async () => ({ ok: false, error: "workstation unreachable" }) }),
    ).toEqual({ ok: false, error: "workstation unreachable" });
    expect(
      await syncWorkspace(db, user, target, {
        ...base,
        readManifest: async () => ({ ok: true, files: {} }),
        writeBatch: async () => ({ ok: false, error: "the workspace could not be updated" }),
      }),
    ).toEqual({ ok: false, error: "the workspace could not be updated" });
  });
});

describe("syncWorkspaceOncePerTurn", () => {
  it("syncs once for a turn and turns an exception into a reported failure", async () => {
    const buildView = vi.fn(async () => new Map());
    const deps = { buildView, readManifest: async () => ({ ok: true as const, files: {} }) };
    const turn = {};
    await syncWorkspaceOncePerTurn(turn, db, user, target, deps);
    await syncWorkspaceOncePerTurn(turn, db, user, target, deps);
    expect(buildView).toHaveBeenCalledTimes(1);
    await syncWorkspaceOncePerTurn({}, db, user, target, deps);
    expect(buildView).toHaveBeenCalledTimes(2);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = await syncWorkspaceOncePerTurn({}, db, user, target, {
      buildView: async () => {
        throw new Error("db down: secret detail");
      },
    });
    expect(failing).toEqual({ ok: false, error: "the documents could not be copied to the workstation" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret detail");
    warn.mockRestore();
  });
});

describe("saveToMike", () => {
  const stored = {
    ok: true as const,
    documentId: "new-doc",
    versionId: "ver",
    versionNumber: 1,
    filename: "summary.md",
    created: true,
    storagePath: "generated/u1/new-doc/summary.md",
  };
  const readOk = (bytes: Buffer) => vi.fn().mockResolvedValue({ ok: true, bytes });

  it("saves a text file to the library", async () => {
    documents.storeDocumentFile.mockResolvedValue(stored);
    const readFile = readOk(Buffer.from("# Summary\n"));
    const result = await saveToMike(db, user, target, { path: "~/mike/out/summary.md", projectId: null }, { readFile });
    expect(result).toEqual({ ...stored, fileType: "md" });
    expect(readFile).toHaveBeenCalledWith(target, "~/mike/out/summary.md", 100 * 1024 * 1024);
    expect(documents.storeDocumentFile).toHaveBeenCalledWith(db, {
      userId: "u1",
      bytes: Buffer.from("# Summary\n"),
      filename: "summary.md",
      fileType: "md",
      projectId: null,
      documentId: undefined,
    });
  });

  it("refuses a type Mike does not keep, before reading anything", async () => {
    const readFile = vi.fn();
    const result = await saveToMike(db, user, target, { path: "out/run.sh" }, { readFile });
    expect(result).toMatchObject({ ok: false });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not what the name says", async () => {
    for (const [name, bytes] of [
      ["report.pdf", Buffer.from("not a pdf")],
      ["deck.pptx", Buffer.from("%PDF-1.7")],
      ["old.doc", Buffer.from("PK\u0003\u0004")],
      ["data.csv", Buffer.from([0x61, 0x00, 0x62])],
      ["photo.png", Buffer.from("plain text")],
    ] as const) {
      const result = await saveToMike(db, user, target, { path: `out/${name}` }, { readFile: readOk(Buffer.from(bytes)) });
      expect(result, name).toMatchObject({ ok: false });
    }
    expect(documents.storeDocumentFile).not.toHaveBeenCalled();
  });

  it("checks project edit access before creating in a project", async () => {
    access.checkProjectAccess.mockResolvedValue({ ok: true, projectRole: "viewer" });
    const readFile = vi.fn();
    expect(await saveToMike(db, user, target, { path: "out/a.md", projectId: "p1" }, { readFile })).toEqual({
      ok: false,
      error: "You cannot add documents to that project.",
    });
    expect(readFile).not.toHaveBeenCalled();

    access.checkProjectAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    documents.storeDocumentFile.mockResolvedValue(stored);
    expect(
      await saveToMike(db, user, target, { path: "out/a.md", projectId: "p1" }, { readFile: readOk(Buffer.from("a")) }),
    ).toMatchObject({ ok: true });
    expect(documents.storeDocumentFile.mock.calls[0]![1]).toMatchObject({ projectId: "p1", documentId: undefined });
  });

  it("versions a document only through a current path and edit access", async () => {
    const view: WorkspaceView = new Map([["projects/Acme/Lease.docx", { ...file("v1"), documentId: "lease" }]]);
    const buildView = vi.fn(async () => view);
    const readFile = readOk(Buffer.from("PK\u0003\u0004rest"));

    expect(
      await saveToMike(db, user, target, { path: "out/Lease.docx", replace: "~/mike/projects/Acme/Other.docx" }, { readFile, buildView }),
    ).toMatchObject({ ok: false });
    expect(
      await saveToMike(db, user, target, { path: "out/Lease.docx", replace: "/tmp/Lease.docx" }, { readFile, buildView }),
    ).toMatchObject({ ok: false });

    documents.ensureDocumentAccess.mockResolvedValue({ ok: true, projectRole: "viewer" });
    expect(
      await saveToMike(db, user, target, { path: "out/Lease.docx", replace: "~/mike/projects/Acme/Lease.docx" }, { readFile, buildView }),
    ).toEqual({ ok: false, error: "You cannot edit that document." });
    expect(readFile).not.toHaveBeenCalled();

    documents.ensureDocumentAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    documents.storeDocumentFile.mockResolvedValue({ ...stored, created: false, versionNumber: 4 });
    expect(
      await saveToMike(db, user, target, { path: "out/Lease.docx", replace: "~/mike/projects/Acme/Lease.docx" }, { readFile, buildView }),
    ).toMatchObject({ ok: true, created: false, versionNumber: 4, fileType: "docx" });
    expect(documents.ensureDocumentAccess).toHaveBeenLastCalledWith("lease", "u1", "owner@example.com", db);
    expect(documents.storeDocumentFile.mock.calls[0]![1]).toMatchObject({ documentId: "lease" });
  });

  it("reports a file the workstation could not hand over", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: false, error: "not a regular file" });
    expect(await saveToMike(db, user, target, { path: "out/link.md" }, { readFile })).toEqual({
      ok: false,
      error: "Could not read out/link.md: not a regular file.",
    });
  });
});
