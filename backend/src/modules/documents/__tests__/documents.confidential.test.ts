// PATCH /single-documents/:documentId { confidential } — owner-only, and
// standalone-only in v1. Access is unchanged: the flag controls visibility
// across the owner's conversations, never who may read the row.

import { describe, expect, it, vi } from "vitest";
import { memoryDb } from "../../../__tests__/helpers/memoryDb";

// getDocument enriches a row from document_versions; that is not this
// service's concern, and the in-memory database has no version of its own.
vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(async (_db: unknown, docs: unknown[]) => docs),
  attachLatestVersionNumbers: vi.fn(async (_db: unknown, docs: unknown[]) => docs),
}));

import { setDocumentConfidential } from "../documents.service";

function store() {
  return memoryDb({
    documents: [
      {
        id: "doc",
        user_id: "owner",
        project_id: null,
        workflow_id: null,
        status: "ready",
        confidential: false,
      },
      {
        id: "project-doc",
        user_id: "owner",
        project_id: "p1",
        workflow_id: null,
        status: "ready",
        confidential: false,
      },
      {
        id: "workflow-doc",
        user_id: "owner",
        project_id: null,
        workflow_id: "w1",
        status: "ready",
        confidential: false,
      },
      {
        id: "foreign",
        user_id: "someone-else",
        project_id: null,
        workflow_id: null,
        status: "ready",
        confidential: false,
      },
    ],
  });
}

describe("setDocumentConfidential", () => {
  it("flips the flag for the owner and answers with the document", async () => {
    const fake = store();

    const result = await setDocumentConfidential(
      "doc",
      "owner",
      "owner@test.local",
      true,
      fake.db,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { id: "doc", confidential: true },
    });
    expect(fake.rows("documents").find((document) => document.id === "doc")!.confidential).toBe(true);
    expect(typeof fake.rows("documents").find((document) => document.id === "doc")!.updated_at).toBe("string");
  });

  it("turns the flag back off", async () => {
    const fake = store();
    fake.rows("documents").find((document) => document.id === "doc")!.confidential = true;

    const result = await setDocumentConfidential(
      "doc",
      "owner",
      undefined,
      false,
      fake.db,
    );

    expect(result).toMatchObject({ ok: true, data: { confidential: false } });
    expect(fake.rows("documents").find((document) => document.id === "doc")!.confidential).toBe(false);
  });

  it("rejects a non-boolean body", async () => {
    const fake = store();

    expect(
      await setDocumentConfidential("doc", "owner", undefined, "true", fake.db),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(
      await setDocumentConfidential("doc", "owner", undefined, undefined, fake.db),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(fake.rows("documents").find((document) => document.id === "doc")!.confidential).toBe(false);
  });

  it.each(["project-doc", "workflow-doc"])(
    "refuses a non-standalone document (%s)",
    async (documentId) => {
      const fake = store();

      expect(
        await setDocumentConfidential(
          documentId,
          "owner",
          undefined,
          true,
          fake.db,
        ),
      ).toMatchObject({ ok: false, kind: "conflict" });
      expect(fake.rows("documents").find((document) => document.id === documentId)!.confidential).toBe(false);
    },
  );

  it("answers not found for someone who is not the owner", async () => {
    const fake = store();

    expect(
      await setDocumentConfidential(
        "foreign",
        "owner",
        "owner@test.local",
        true,
        fake.db,
      ),
    ).toMatchObject({ ok: false, kind: "not_found" });
    expect(fake.rows("documents").find((document) => document.id === "foreign")!.confidential).toBe(false);
  });
});
