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
vi.mock("../../../lib/access", () => ({
  ensureDocAccess: (...args: unknown[]) => ensureDocAccess(...args),
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

import { buildDocContext } from "./contextBuilders";

type Doc = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  org_id?: string | null;
  workflow_id?: string | null;
  status?: string;
  confidential?: boolean;
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

// Documents are shared by default across the owner's conversations: a
// standalone chat sees the caller's own standalone, non-confidential
// documents even when this conversation never referenced them. The referenced
// set always survives; the cap only limits the extras.
describe("buildDocContext shared standalone documents", () => {
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
    confidential: false,
    ...extra,
  });

  it("includes the caller's own non-confidential standalone documents", async () => {
    const db = makeDb([
      standalone("d-shared", "u1", { updated_at: "2026-10-01T00:00:00Z" }),
      standalone("d-secret", "u1", {
        confidential: true,
        updated_at: "2026-10-02T00:00:00Z",
      }),
      {
        id: "d-project",
        user_id: "u1",
        project_id: "p1",
        status: "ready",
        confidential: false,
        updated_at: "2026-10-03T00:00:00Z",
      },
      standalone("d-other-user", "u2", {
        updated_at: "2026-10-04T00:00:00Z",
      }),
    ]);

    const { docIndex } = await buildDocContext(
      message([]),
      "u1",
      db,
      "chat-1",
      "chat_messages",
      "u1@test.local",
      true, // sender's private standalone chat — the sweep is on
    );

    // Not the confidential document, not a project document (its scope is
    // governed elsewhere), and never another user's document.
    expect(Object.values(docIndex).map((entry) => entry.document_id)).toEqual([
      "d-shared",
    ]);
  });

  it("does not sweep a guest's library into a chat someone else reads", async () => {
    const db = makeDb([
      standalone("d-host", "u1"),
      standalone("d-host-secret", "u1", { confidential: true }),
      standalone("d-guest", "guest-1"),
    ]);

    // A guest sending in a host's shared chat: the sweep is off (the route
    // passes the shared-audience verdict), so the guest's own library does
    // not ride into a transcript the host reads — the same boundary the
    // confidential flag exists to keep.
    const { docIndex } = await buildDocContext(
      message([]),
      "guest-1",
      db,
      "guest-chat",
      "chat_messages",
    );

    expect(docIndex).toEqual({});
  });

  it("leaves a builder call without a chat id alone (project attachments)", async () => {
    const db = makeDb([standalone("d-standalone", "u1")]);

    const { docIndex } = await buildDocContext(
      message([]),
      "u1",
      db,
      undefined,
      undefined,
      "u1@test.local",
    );

    expect(docIndex).toEqual({});
  });

  it("caps the total at 50, newest first, and keeps every referenced document", async () => {
    const referenced = ["d-ref-0", "d-ref-1", "d-ref-2"];
    const extras: Doc[] = Array.from({ length: 60 }, (_, index) =>
      standalone(`d-extra-${String(index).padStart(2, "0")}`, "u1", {
        // 60 minutes apart, so the newest is the highest index.
        updated_at: new Date(
          Date.UTC(2026, 0, 1) + index * 60_000,
        ).toISOString(),
      }),
    );
    const db = makeDb([
      ...referenced.map((id, index) =>
        standalone(id, "u1", {
          // One referenced document is NEWER than every extra, so a query
          // that does not exclude referenced ids would spend a slot on it
          // and come up one document short of the ceiling.
          updated_at:
            index === 0
              ? "2027-01-01T00:00:00Z"
              : `2020-01-0${index + 1}T00:00:00Z`,
        }),
      ),
      ...extras,
    ]);

    const { docIndex } = await buildDocContext(
      message(referenced),
      "u1",
      db,
      "chat-2",
      "chat_messages",
      undefined,
      true,
    );
    const ids = Object.values(docIndex).map((entry) => entry.document_id);

    expect(ids).toHaveLength(50);
    for (const id of referenced) expect(ids).toContain(id);
    // 47 newest extras fill the rest; the oldest extra is pushed out.
    expect(ids).toContain("d-extra-59");
    expect(ids).toContain("d-extra-13");
    expect(ids).not.toContain("d-extra-12");
  });

  it("never truncates the referenced set, even past the cap", async () => {
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
