import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// buildDocContext — which attached documents the model may actually read.
//
// The builder used to filter with `.eq("user_id", userId)`: "I uploaded it"
// stood in for "I may read it". So a colleague's document in a shared
// organization matter, and any document whose uploader's account had been
// deleted (documents.user_id → NULL), were dropped from the context — the
// assistant claimed it could not see a file the caller has full access to.
//
// The verdict is now per document (ensureDocAccess), which must cut BOTH
// ways: being mentioned in a chat the caller can read is not itself access.
// ---------------------------------------------------------------------------

vi.mock("../../../lib/db", () => ({ createDb: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn() }));

const ensureDocAccess = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const listAccessibleProjectIds = vi.fn(async (..._args: unknown[]) => [] as string[]);
vi.mock("../../../lib/access", () => ({
  ensureDocAccess: (...args: unknown[]) => ensureDocAccess(...args),
  listAccessibleProjectIds: (...args: unknown[]) => listAccessibleProjectIds(...args),
}));

// Version enrichment is a separate concern; give every surviving doc a path
// so the builder's "no bytes yet" skip never masks an access result.
vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(
    async (_db: unknown, docs: Record<string, unknown>[]) => {
      for (const doc of docs) {
        doc.storage_path = `docs/${doc.id}.docx`;
        doc.filename = `${doc.id}.docx`;
        doc.file_type = "docx";
      }
      return docs;
    },
  ),
}));

import { buildDocContext, expandAccountDocContext } from "./contextBuilders";
import { resolveDocLabel, type DocIndex, type DocStore } from "./types";

type Doc = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  org_id?: string | null;
  workflow_id?: string | null;
  status?: string;
  updated_at?: string;
};

/**
 * Honours the `.eq()` filters it is given, so a test fails if the builder
 * goes back to scoping documents by uploader in SQL.
 */
function makeDb(docs: Doc[]) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      const excluded: Record<string, string[]> = {};
      let orderBy: { column: string; ascending: boolean } | null = null;
      let max: number | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        is: (column: string, value: unknown) => {
          filters[`is:${column}`] = value;
          return b;
        },
        order: (column: string, options: { ascending?: boolean } = {}) => {
          orderBy = { column, ascending: options.ascending !== false };
          return b;
        },
        limit: (count: number) => {
          max = count;
          return b;
        },
        not: (column: string, _operator: string, value: string[]) => {
          excluded[column] = value;
          return b;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return b;
        },
        in: (column: string, value: unknown) => {
          filters[`in:${column}`] = value;
          return b;
        },
        then: (resolve: (v: unknown) => unknown) => {
          const ids = (filters["in:id"] as string[] | undefined) ?? null;
          let data = docs.filter((doc) => {
            const row = doc as Record<string, unknown>;
            if (ids && !ids.includes(doc.id)) return false;
            for (const [column, value] of Object.entries(filters)) {
              if (column.startsWith("in:")) continue;
              if (column.startsWith("is:")) {
                if ((row[column.slice(3)] ?? null) !== value) return false;
                continue;
              }
              if (row[column] !== value) return false;
            }
            for (const [column, values] of Object.entries(excluded)) {
              if (values.includes(row[column] as string)) return false;
            }
            return true;
          });
          if (orderBy) {
            const { column, ascending } = orderBy;
            data = [...data].sort((left, right) => {
              const a = String((left as Record<string, unknown>)[column] ?? "");
              const b2 = String((right as Record<string, unknown>)[column] ?? "");
              return ascending ? a.localeCompare(b2) : b2.localeCompare(a);
            });
          }
          if (max !== null) data = data.slice(0, max);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    },
  } as never;
}

const message = (documentIds: string[]) => [
  {
    role: "user" as const,
    content: "look at these",
    files: documentIds.map((id) => ({ document_id: id })),
  },
] as never;

describe("buildDocContext access scoping", () => {
  beforeEach(() => {
    ensureDocAccess.mockReset().mockResolvedValue({ ok: true });
  });

  it("includes documents the caller did not upload but may read", async () => {
    const db = makeDb([
      { id: "d-colleague", user_id: "u2", project_id: "p1", status: "ready" },
      { id: "d-detached", user_id: null, project_id: "p1", status: "ready" },
    ]);

    const { docIndex } = await buildDocContext(
      message(["d-colleague", "d-detached"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(
      Object.values(docIndex).map((entry) => entry.document_id).sort(),
    ).toEqual(["d-colleague", "d-detached"]);
  });

  it("drops a document the caller has no verdict for, however it was cited", async () => {
    ensureDocAccess.mockImplementation(async (doc: unknown) => ({
      ok: (doc as { id: string }).id === "d-mine",
    }));
    const db = makeDb([
      { id: "d-mine", user_id: "u1", project_id: null, status: "ready" },
      // Uploaded by the CALLER, so nothing but the verdict can exclude it.
      // With `user_id: "u2"` the old uploader-scoped filter dropped this row
      // too, and the test passed whether or not the verdict was consulted.
      { id: "d-walled", user_id: "u1", project_id: "p-walled", status: "ready" },
    ]);

    const { docIndex, docStore } = await buildDocContext(
      message(["d-mine", "d-walled"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(Object.values(docIndex).map((entry) => entry.document_id)).toEqual([
      "d-mine",
    ]);
    expect([...docStore.values()].map((entry) => entry.storage_path)).toEqual([
      "docs/d-mine.docx",
    ]);
  });

  it("passes the caller's email so a direct grant still resolves", async () => {
    const db = makeDb([
      { id: "d1", user_id: "u2", project_id: "p1", status: "ready" },
    ]);

    await buildDocContext(
      message(["d1"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(ensureDocAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1" }),
      "u1",
      "u1@test.local",
      db,
    );
  });

  it("labels a document from its id, so an earlier removal renames nothing", async () => {
    const a = "3f9a1c2e-0000-4000-8000-000000000001";
    const b = "b71d0c55-0000-4000-8000-000000000002";
    const both = makeDb([
      { id: a, user_id: "u1", project_id: null, status: "ready" },
      { id: b, user_id: "u1", project_id: null, status: "ready" },
    ]);
    const only = makeDb([{ id: b, user_id: "u1", project_id: null, status: "ready" }]);

    const first = await buildDocContext(message([a, b]), "u1", both, null, "chat_messages", "u1@test.local");
    const later = await buildDocContext(message([b]), "u1", only, null, "chat_messages", "u1@test.local");

    expect(Object.keys(first.docIndex).sort()).toEqual(["doc-3f9a1c2e", "doc-b71d0c55"]);
    expect(Object.keys(later.docIndex)).toEqual(["doc-b71d0c55"]);
    expect(later.docIndex["doc-b71d0c55"].document_id).toBe(b);
  });

  it("asks once per container, not once per document", async () => {
    // ensureDocAccess resolves a document through its project, then its
    // workflow, then its org — two or three round trips each. A turn citing
    // five files from one matter used to pay for five identical project
    // lookups before the model saw a byte. The container's answer does not
    // depend on which document inside it was asked about.
    const db = makeDb([
      { id: "d1", user_id: "u1", project_id: "p1", status: "ready" },
      { id: "d2", user_id: "u2", project_id: "p1", status: "ready" },
      { id: "d3", user_id: null, project_id: "p1", status: "ready" },
      { id: "d4", user_id: "u2", project_id: "p2", status: "ready" },
      // No container at all: resolved individually, which is an in-memory
      // `user_id === caller` comparison rather than a round trip.
      { id: "d5", user_id: "u1", project_id: null, status: "ready" },
    ]);

    const { docIndex } = await buildDocContext(
      message(["d1", "d2", "d3", "d4", "d5"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    // Every document still reaches the model...
    expect(
      Object.values(docIndex)
        .map((entry) => entry.document_id)
        .sort(),
    ).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    // ...on three verdicts: project p1, project p2, and the container-less
    // d5. Five would mean the fan-out is back.
    expect(ensureDocAccess).toHaveBeenCalledTimes(3);
    const containers = ensureDocAccess.mock.calls.map(
      (call) => (call[0] as { project_id: string | null }).project_id,
    );
    expect(containers.sort()).toEqual([null, "p1", "p2"]);
  });

  it("refuses a whole container once, without re-asking per document", async () => {
    // The cache must cut both ways: a denied container denies every document
    // in it, and still only costs one verdict.
    ensureDocAccess.mockImplementation(async (doc: unknown) => ({
      ok: (doc as { project_id: string | null }).project_id === "p-open",
    }));
    const db = makeDb([
      { id: "d1", user_id: "u1", project_id: "p-open", status: "ready" },
      { id: "d2", user_id: "u1", project_id: "p-walled", status: "ready" },
      { id: "d3", user_id: "u1", project_id: "p-walled", status: "ready" },
    ]);

    const { docIndex } = await buildDocContext(
      message(["d1", "d2", "d3"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(Object.values(docIndex).map((entry) => entry.document_id)).toEqual([
      "d1",
    ]);
    expect(ensureDocAccess).toHaveBeenCalledTimes(2);
  });
});

describe("buildDocContext unreferenced document boundary", () => {
  beforeEach(() => {
    ensureDocAccess.mockReset().mockResolvedValue({ ok: true });
  });

  const standalone = (
    id: string,
    userId: string,
    extra: Partial<Doc> = {},
  ): Doc => ({
    id,
    user_id: userId,
    project_id: null,
    workflow_id: null,
    status: "ready",
    ...extra,
  });

  it("does not preload unreferenced library or project documents into prompt context", async () => {
    const db = makeDb([
      standalone("d-library", "u1", { updated_at: "2026-10-01T00:00:00Z" }),
      {
        id: "d-project",
        user_id: "u1",
        project_id: "p1",
        status: "ready",
        updated_at: "2026-10-03T00:00:00Z",
      },
      standalone("d-other-user", "u2", {
        updated_at: "2026-10-04T00:00:00Z",
      }),
    ]);

    const { docIndex, docStore } = await buildDocContext(
      message([]),
      "u1",
      db,
      "chat-1",
      "chat_messages",
      "u1@test.local",
    );

    expect(docIndex).toEqual({});
    expect(docStore.size).toBe(0);
  });

  it("keeps every referenced document without truncation", async () => {
    const referenced = Array.from({ length: 55 }, (_, index) =>
      `d-ref-${String(index).padStart(2, "0")}`,
    );
    const db = makeDb(
      referenced.map((id) =>
        standalone(id, "u1", { updated_at: "2026-01-01T00:00:00Z" }),
      ),
    );

    const { docIndex } = await buildDocContext(
      message(referenced),
      "u1",
      db,
      "chat-3",
      "chat_messages",
    );

    expect(Object.keys(docIndex)).toHaveLength(55);
  });
});

describe("expandAccountDocContext private owner resolution", () => {
  beforeEach(() => {
    ensureDocAccess.mockReset().mockResolvedValue({ ok: true });
    listAccessibleProjectIds.mockReset().mockResolvedValue([]);
  });

  function makeWorkspaceDb(args: {
    projects: { id: string; name: string; created_at: string }[];
    documents: Record<string, unknown>[];
    versions: Record<string, unknown>[];
  }) {
    return {
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        let inColumn: { col: string; values: unknown[] } | null = null;
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return b;
          },
          is: (col: string, val: unknown) => {
            filters[`is:${col}`] = val;
            return b;
          },
          in: (col: string, values: unknown[]) => {
            inColumn = { col, values };
            return b;
          },
          order: () => b,
          range: () => b,
          then: (resolve: (v: unknown) => unknown) => {
            const source =
              table === "projects"
                ? args.projects
                : table === "documents"
                  ? args.documents
                  : table === "document_versions"
                    ? args.versions
                    : [];
            const data = source.filter((row: Record<string, unknown>) => {
              if (inColumn && !inColumn.values.includes(row[inColumn.col])) {
                return false;
              }
              for (const [k, v] of Object.entries(filters)) {
                if (k.startsWith("is:")) {
                  if ((row[k.slice(3)] ?? null) !== v) return false;
                } else if (row[k] !== v) {
                  return false;
                }
              }
              return true;
            });
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return b;
      },
    } as never;
  }

  it("resolves authorized documents across projects A and B, library, templates and derived files by label, UUID, filename or ~/mike path", async () => {
    listAccessibleProjectIds.mockResolvedValue(["proj-a", "proj-b"]);
    const db = makeWorkspaceDb({
      projects: [
        { id: "proj-a", name: "Matter A", created_at: "2026-01-01T00:00:00Z" },
        { id: "proj-b", name: "Matter B", created_at: "2026-01-02T00:00:00Z" },
        { id: "proj-c", name: "Matter C", created_at: "2026-01-03T00:00:00Z" },
      ],
      documents: [
        {
          id: "aaaa1111-0000-4000-8000-000000000001",
          project_id: "proj-a",
          folder_id: null,
          library_kind: "file",
          library_folder_id: null,
          current_version_id: "ver-a",
          status: "ready",
          created_at: "2026-02-01T00:00:00Z",
        },
        {
          id: "bbbb2222-0000-4000-8000-000000000002",
          project_id: "proj-b",
          folder_id: null,
          library_kind: "file",
          library_folder_id: null,
          current_version_id: "ver-b",
          status: "ready",
          created_at: "2026-02-02T00:00:00Z",
        },
        {
          id: "cccc3333-0000-4000-8000-000000000003",
          project_id: "proj-c",
          folder_id: null,
          library_kind: "file",
          library_folder_id: null,
          current_version_id: "ver-c",
          status: "ready",
          created_at: "2026-02-03T00:00:00Z",
        },
        {
          id: "dddd4444-0000-4000-8000-000000000004",
          user_id: "u1",
          project_id: null,
          workflow_id: null,
          folder_id: null,
          library_kind: null, // derived/generated standalone document
          library_folder_id: null,
          current_version_id: "ver-derived",
          status: "ready",
          created_at: "2026-02-04T00:00:00Z",
        },
      ],
      versions: [
        {
          id: "ver-a",
          filename: "Lease-A.docx",
          file_type: "docx",
          storage_path: "store/lease-a.docx",
          size_bytes: 120,
          version_number: 1,
          deleted_at: null,
        },
        {
          id: "ver-b",
          filename: "Schedule-B.pdf",
          file_type: "pdf",
          storage_path: "store/schedule-b.pdf",
          size_bytes: 240,
          version_number: 2,
          deleted_at: null,
        },
        {
          id: "ver-c",
          filename: "Forbidden-C.pdf",
          file_type: "pdf",
          storage_path: "store/forbidden-c.pdf",
          size_bytes: 300,
          version_number: 1,
          deleted_at: null,
        },
        {
          id: "ver-derived",
          filename: "Derived-Summary.docx",
          file_type: "docx",
          storage_path: "store/derived.docx",
          size_bytes: 180,
          version_number: 3,
          deleted_at: null,
        },
      ],
    });

    const docStore: DocStore = new Map();
    const docIndex: DocIndex = {};
    await expandAccountDocContext(
      db,
      { id: "u1", email: "u1@test.local" },
      docStore,
      docIndex,
    );

    expect(listAccessibleProjectIds).toHaveBeenCalledWith(
      "u1",
      "u1@test.local",
      db,
    );
    expect(Object.keys(docIndex).sort()).toEqual([
      "doc-aaaa1111",
      "doc-bbbb2222",
      "doc-dddd4444",
    ]);
    // Unauthorized Matter C is never included.
    expect(resolveDocLabel("Forbidden-C.pdf", docStore, docIndex)).toBeNull();
    expect(
      resolveDocLabel("projects/Matter C/Forbidden-C.pdf", docStore, docIndex),
    ).toBeNull();

    // Both Matter A, Matter B, and derived files resolve by label, UUID, filename, and ~/mike path.
    expect(
      resolveDocLabel(
        "~/mike/projects/Matter A/Lease-A.docx",
        docStore,
        docIndex,
      ),
    ).toBe("doc-aaaa1111");
    expect(
      resolveDocLabel("projects/Matter B/Schedule-B.pdf", docStore, docIndex),
    ).toBe("doc-bbbb2222");
    expect(
      resolveDocLabel(
        "/home/agent/mike/library/Derived-Summary.docx",
        docStore,
        docIndex,
      ),
    ).toBe("doc-dddd4444");
    expect(docIndex["doc-dddd4444"]).toMatchObject({
      document_id: "dddd4444-0000-4000-8000-000000000004",
      version_id: "ver-derived",
      version_number: 3,
      workspace_path: "library/Derived-Summary.docx",
    });
  });
});
