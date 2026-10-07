import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { scriptedDb } from "../../../../../__tests__/helpers/scriptedDb";
import type { Db } from "../../../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../../../../lib/documentVersions", () => ({
  loadActiveVersion: mocks.active,
  contentSha256: () => "hash",
}));

vi.mock("../../../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));

vi.mock("../../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: (path: string, filename: string) =>
    `download:${filename}:${path}`,
}));

import { runEditDocument, runReadBlocks } from "../documentOps";

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
    id: "active",
    filename: "Contract.docx",
    storage_path: "current.docx",
  });
});

describe("runReadBlocks", () => {
  it("extracts structured blocks with stable IDs from document bytes", async () => {
    const docBuffer = await makeDocxBuffer(
      para("Clause 1: Definitions") +
        para("Clause 2: Obligations") +
        para("Clause 3: Termination"),
    );
    mocks.downloadFile.mockResolvedValue(
      docBuffer.buffer.slice(
        docBuffer.byteOffset,
        docBuffer.byteOffset + docBuffer.byteLength,
      ),
    );

    const fake = scriptedDb([]);

    const res = await runReadBlocks({
      documentId: "doc-1",
      db: fake.db as unknown as Db,
      startId: "p_1",
      endId: "p_2",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.blocks).toHaveLength(2);
      expect(res.blocks[0]).toMatchObject({ id: "p_1", text: "Clause 1: Definitions" });
      expect(res.blocks[1]).toMatchObject({ id: "p_2", text: "Clause 2: Obligations" });
    }
  });
});

describe("runEditDocument with operations", () => {
  it("executes atomic replace_block and creates version with pending edits", async () => {
    const docBuffer = await makeDocxBuffer(
      para("Fee is $10,000 per month.") + para("Governing law is NY."),
    );
    mocks.downloadFile.mockResolvedValue(
      docBuffer.buffer.slice(
        docBuffer.byteOffset,
        docBuffer.byteOffset + docBuffer.byteLength,
      ),
    );

    const editRow = {
      id: "edit-1",
      change_id: "change-1",
      deleted_text: "Fee is $10,000 per month.",
      inserted_text: "Fee is $5,000 per month.",
      context_before: "",
      context_after: "",
    };

    const fake = scriptedDb([
      { table: "documents", data: { id: "doc-1" } },
      { table: "user_profiles", data: { display_name: "Attorney" } },
      { table: "document_versions", data: { filename: "Contract.docx" } },
      {
        table: "document_edits",
        op: "insert",
        data: [editRow],
      },
    ]);

    const rpc = vi.fn(async (name: string) => {
      if (name === "create_document_version") {
        return { data: { id: "v2", version_number: 2 }, error: null };
      }
      return { data: true, error: null };
    });

    const db = { ...fake.db, rpc } as unknown as Db;

    const res = await runEditDocument({
      documentId: "doc-1",
      userId: "user-1",
      operations: [
        {
          op: "replace_block",
          blockId: "p_1",
          newContent: "Fee is $5,000 per month.",
          expectedContent: "$10,000 per month",
        },
      ],
      db,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.version_number).toBe(2);
      expect(res.annotations).toHaveLength(1);
      expect(res.annotations[0]).toMatchObject({
        kind: "edit",
        edit_id: "edit-1",
      });
      expect(mocks.uploadFile).toHaveBeenCalled();
    }
  });

  it("fails closed when replace_block expectedContent precondition fails", async () => {
    const docBuffer = await makeDocxBuffer(para("Original text"));
    mocks.downloadFile.mockResolvedValue(
      docBuffer.buffer.slice(
        docBuffer.byteOffset,
        docBuffer.byteOffset + docBuffer.byteLength,
      ),
    );

    const fake = scriptedDb([
      { table: "documents", data: { id: "doc-1" } },
      { table: "user_profiles", data: { display_name: "Attorney" } },
    ]);

    const rpc = vi.fn();
    const db = { ...fake.db, rpc } as unknown as Db;

    const res = await runEditDocument({
      documentId: "doc-1",
      userId: "user-1",
      operations: [
        {
          op: "replace_block",
          blockId: "p_1",
          newContent: "New text",
          expectedContent: "Completely different text",
        },
      ],
      db,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Precondition failed for block 'p_1'");
      // No upload or new version must occur on precondition failure
      expect(mocks.uploadFile).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    }
  });
});
