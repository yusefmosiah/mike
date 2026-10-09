import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { scriptedDb } from "../../../../../__tests__/helpers/scriptedDb";
import type { Db } from "../../../../../lib/db";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../../../../../lib/documentVersions", () => ({
  loadActiveVersion: mocks.active,
  contentSha256: () => "hash",
}));

vi.mock("../../../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
}));

import { runGetDiff } from "../documentOps";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocxBuffer(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.active.mockResolvedValue({
    id: "version-1",
    version_number: 2,
    filename: "Report.docx",
    storage_path: "report.docx",
  });
});

describe("runGetDiff", () => {
  it("returns structured diff and valid lint status for pending document edits", async () => {
    const docBuffer = await makeDocxBuffer(para("Section 1"));
    mocks.downloadFile.mockResolvedValue(
      docBuffer.buffer.slice(
        docBuffer.byteOffset,
        docBuffer.byteOffset + docBuffer.byteLength,
      ),
    );

    const pendingEdits = [
      {
        change_id: "c-1",
        deleted_text: "Section 1",
        inserted_text: "Section 1: Executive Overview",
        status: "pending",
      },
    ];

    const fake = scriptedDb([
      {
        table: "document_edits",
        data: pendingEdits,
      },
    ]);

    const res = await runGetDiff({
      documentId: "doc-1",
      db: fake.db as unknown as Db,
    });

    expect(res.ok).toBe(true);
    // Only columns document_edits really has (PostgREST rejects the query otherwise).
    const query = fake.calls.find((c) => c.table === "document_edits")!;
    const table = readFileSync(path.resolve(__dirname, "../../../../../../schema.sql"), "utf8").match(
      /create table if not exists public\.document_edits \(([\s\S]*?)\n\);/,
    )![1];
    for (const column of query.columns!.split(",").map((c) => c.trim())) {
      expect(table, `document_edits.${column}`).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    expect(query.filters).toContainEqual(["eq", "status", "pending"]);
    if (res.ok) {
      expect(res.has_changes).toBe(true);
      expect(res.version_number).toBe(2);
      expect(res.filename).toBe("Report.docx");
      expect(res.changes).toHaveLength(1);
      expect(res.changes[0]).toMatchObject({
        op: "replace",
        before: "Section 1",
        after: "Section 1: Executive Overview",
      });
      expect(res.lint.valid).toBe(true);
      expect(res.lint.errors).toHaveLength(0);
    }
  });

  it("returns has_changes: false when no pending edits exist", async () => {
    const docBuffer = await makeDocxBuffer(para("Clean document"));
    mocks.downloadFile.mockResolvedValue(
      docBuffer.buffer.slice(
        docBuffer.byteOffset,
        docBuffer.byteOffset + docBuffer.byteLength,
      ),
    );

    const fake = scriptedDb([
      {
        table: "document_edits",
        data: [],
      },
    ]);

    const res = await runGetDiff({
      documentId: "doc-1",
      db: fake.db as unknown as Db,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.has_changes).toBe(false);
      expect(res.changes).toHaveLength(0);
      expect(res.lint.valid).toBe(true);
    }
  });

  it("detects package invariant violations and returns lint.valid: false", async () => {
    // Document with dangling footnote reference
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>Bad citation</w:t><w:footnoteReference w:id="99"/></w:r></w:p></w:body></w:document>`,
    );
    const brokenBuffer = await zip.generateAsync({ type: "nodebuffer" });

    mocks.downloadFile.mockResolvedValue(
      brokenBuffer.buffer.slice(
        brokenBuffer.byteOffset,
        brokenBuffer.byteOffset + brokenBuffer.byteLength,
      ),
    );

    const fake = scriptedDb([
      {
        table: "document_edits",
        data: [],
      },
    ]);

    const res = await runGetDiff({
      documentId: "doc-1",
      db: fake.db as unknown as Db,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.lint.valid).toBe(false);
      expect(res.lint.errors.length).toBeGreaterThan(0);
      expect(res.lint.errors[0]).toContain("footnote");
    }
  });
});
