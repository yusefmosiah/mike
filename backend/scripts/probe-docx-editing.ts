// Mission 1b/1c probe: tracked-change editing through the real tool dispatcher.
//
// Runs against a local stack (docker compose up -d db auth rest gateway
// db-init mailpit storage createbucket) with the well-known local keys:
//
//   cd backend && npx tsx scripts/probe-docx-editing.ts
//
// Part 1 (UK Model Services Contract core terms): what a model would do —
// read, find, one edit_document batch with every kind of edit (replace,
// insert, range delete across a table, empty-paragraph delete, bold, a new
// footnote, a new link, a new table row), get_diff; a second turn that types
// inside the first turn's pending insertion; accept and reject through the
// documents service; a batch with one bad target changes nothing.
//
// Part 2 (academy transfer agreement, which has no Word paragraph ids):
// after an inserted paragraph is accepted, "p20" still names the paragraph
// it named before, and the inserted paragraph keeps its id.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJtaWtlLWxvY2FsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.uD8koYAMq_1hAlVmm1t5PYasyb98YME7G_UYVa5ME1Y";
process.env.AUTH_URL ??= "http://localhost:54321";
process.env.AUTH_SERVICE_KEY ??= LOCAL_SERVICE_KEY;
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:54322/postgres";
process.env.R2_ENDPOINT_URL ??= "http://localhost:9000";
process.env.R2_ACCESS_KEY_ID ??= "rustfsadmin";
process.env.R2_SECRET_ACCESS_KEY ??= "rustfsadmin";
process.env.R2_BUCKET_NAME ??= "mike";
process.env.DOWNLOAD_SIGNING_SECRET ??= "probe-download-signing-secret-not-for-production";

const FIXTURES = path.resolve(__dirname, "../src/__tests__/fixtures/docx/public-legal");

function section(title: string) {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);
}

function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const { createDb } = await import("../src/lib/db");
  const { uploadFile, downloadFile } = await import("../src/lib/storage");
  const { createDocumentVersion, resolveEdit, docxViewForVersion } = await import("../src/modules/documents/documents.service");
  const { runToolCalls } = await import("../src/modules/chat/engine/tools/toolDispatcher");
  const { DocxDocument } = await import("../src/lib/docx/view");
  const { renderInlines } = await import("../src/lib/docx/render");
  const { loadActiveVersion } = await import("../src/lib/documentVersions");

  const db = createDb();
  const email = `probe-${Date.now()}@mike.local`;
  const { data: created, error: userErr } = await db.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
  if (userErr || !created.user) throw new Error(`createUser: ${userErr?.message}`);
  const userId = created.user.id;

  /** Upload a fixture as a document and return a tool runner bound to it. */
  async function setup(fixture: string, filename: string) {
    const bytes = readFileSync(path.join(FIXTURES, fixture));
    const { data: docRow, error: docErr } = await db.from("documents").insert({ user_id: userId, status: "ready" }).select("id").single();
    if (docErr || !docRow) throw new Error(`documents insert: ${docErr?.message}`);
    const documentId = docRow.id as string;
    const storagePath = `documents/${userId}/${documentId}/source.docx`;
    await uploadFile(storagePath, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const { data: v1, error: vErr } = await createDocumentVersion(db, {
      document_id: documentId,
      storage_path: storagePath,
      source: "upload",
      filename,
      file_type: "docx",
      size_bytes: bytes.byteLength,
      page_count: null,
      content_sha256: null,
    } as never);
    if (vErr || !v1) throw new Error(`createDocumentVersion: ${vErr?.message}`);
    const docStore = new Map([["doc-0", { storage_path: storagePath, file_type: "docx", filename }]]);
    const docIndex = { "doc-0": { document_id: documentId, filename, version_id: v1.id, version_number: v1.version_number } };
    let turnEditState = new Map();
    let turnReadState = new Map();
    let call = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await runToolCalls(
        [{ id: `call-${++call}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] as never,
        docStore as never,
        userId,
        db,
        () => undefined,
        undefined,
        undefined,
        docIndex as never,
        turnEditState as never,
        turnReadState as never,
      );
      return { res, content: (res.toolResults[0] as { content: string }).content };
    };
    const newTurn = () => {
      turnEditState = new Map();
      turnReadState = new Map();
    };
    // The active version as the app reads it: labelled with its block ids.
    const active = async () => {
      const v = await loadActiveVersion(documentId, db);
      return docxViewForVersion(db, documentId, v!.id, Buffer.from((await downloadFile(v!.storage_path))!));
    };
    return { bytes, documentId, tool, newTurn, active };
  }

  // -------------------------------------------------------------------------
  section("Part 1: MSC core terms");
  const msc = await setup("uk-msc-core-terms-v2.2a.docx", "MSC Core Terms.docx");
  const read = await msc.tool("read_document", { doc_id: "doc-0" });
  check("read_document returns an outline and block ids", read.content.includes("Outline (") && read.content.includes("[000000C5]"));
  const sec = await msc.tool("read_document", { doc_id: "doc-0", section: "5.3" });
  check("section 5.3 includes its sub-clauses", sec.content.includes("5.3.1 perform its obligations") && sec.content.includes("5.3.3 deliver"));

  const view = await DocxDocument.load(msc.bytes);
  const t = view.blocks.findIndex((b, i) => b.kind === "table" && view.blocks[i - 1]?.kind === "paragraph" && view.blocks[i + 1]?.kind === "paragraph");
  const rangeFrom = view.blocks[t - 1].id;
  const rangeTo = view.blocks[t + 1].id;
  const empty = view.blocks.find((b, i) => i > t + 5 && b.kind === "paragraph" && b.text.trim() === "" && i < view.blocks.length - 1)!;
  const cell = view.paragraphs.find((p) => p.id === "00000021")!;
  const cellCount = (view.byId.get(cell.cell!.tableId) as { rows: { cells: unknown[] }[] }).rows[cell.cell!.row].cells.length;

  section("edit_document: every kind of edit in one batch");
  const batch = [
    { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract", reason: "Defined usage" },
    { op: "insert", after: "00000124", paragraphs: ["provide the Authority with a monthly service report."], reason: "Reporting" },
    { op: "delete", block: rangeFrom, through: rangeTo, reason: "Remove the version table" },
    { op: "delete", block: empty.id, reason: "Stray empty paragraph" },
    { op: "format", block: "00000123", find: "indemnify the Authority", bold: true, reason: "Emphasis" },
    { op: "replace", block: "00000122", find: "established procedures", replace: "established procedures{footnote: As notified to the Authority in writing.}", reason: "Clarify" },
    { op: "replace", block: "0000011C", find: "all applicable Law;", replace: "all applicable [Law](https://www.legislation.gov.uk);", reason: "Source" },
    { op: "insert_row", after: "00000021", cells: Array.from({ length: cellCount }, (_, i) => `new ${i + 1}`), reason: "History" },
  ];
  const edit = await msc.tool("edit_document", { doc_id: "doc-0", edits: batch });
  check("batch applied", JSON.parse(edit.content).ok === true);
  const cards = edit.res.docsEdited[0]?.annotations ?? [];
  console.log(cards.map((a) => `card: -${JSON.stringify(a.deleted_text.slice(0, 50))} +${JSON.stringify(a.inserted_text.slice(0, 70))} (${a.reason ?? ""})`).join("\n"));
  check("one card per edit", cards.length === batch.length);

  const diff = JSON.parse((await msc.tool("get_diff", { doc_id: "doc-0" })).content) as { changes: { op: string }[]; lint: { valid: boolean }; summary: string };
  console.log(diff.summary);
  check("get_diff lists every change, the bold one as formatting", diff.changes.length === batch.length && diff.changes.some((c) => c.op === "format"));
  check("get_diff lint valid", diff.lint.valid);

  const reread = await msc.tool("read_document", { doc_id: "doc-0", from: "0000011B", to: "00000125" });
  console.log(reread.content.split("\n").filter((l) => /^\[0000011[BC]\]|^\[0000012[2-4]/.test(l) || l.startsWith("[^")).join("\n"));
  check("the new footnote is read with its text", /established procedures\{\+\+\[\^\d+\]\+\+\}/.test(reread.content) && /\[\^\d+\]: \[fn\d+\.1\] \{\+\+.*As notified to the Authority in writing\.\+\+\}/.test(reread.content));
  check("the new link is read with its target", reread.content.includes("[{++Law++}](https://www.legislation.gov.uk)"));

  section("second turn: type inside the first turn's pending insertion");
  const wIds = async (editId: string) => ((await db.from("document_edits").select("w_ids").eq("id", editId).single()).data?.w_ids ?? []) as string[];
  const insertIdsBefore = await wIds(cards[1].edit_id);
  msc.newTurn();
  const split = await msc.tool("edit_document", {
    doc_id: "doc-0",
    edits: [{ op: "replace", block: "00000124+1", find: "a monthly service report", replace: "a detailed monthly service report" }],
  });
  check("split edit applied", JSON.parse(split.content).ok === true);
  const insertIdsAfter = await wIds(cards[1].edit_id);
  console.log(`insert card revision ids: ${insertIdsBefore.join(",")} -> ${insertIdsAfter.join(",")}`);
  check("the first turn's card gained the split revision id", insertIdsAfter.length === insertIdsBefore.length + 1);

  section("accept and reject through the documents service");
  const ok = async (mode: "accept" | "reject", id: string) => (await resolveEdit(mode, msc.documentId, id, userId, email, db)).ok;
  check("accept the replace", await ok("accept", cards[0].edit_id));
  check("accept the inserted paragraph (both halves of the split insertion)", await ok("accept", cards[1].edit_id));
  check("reject the footnote", await ok("reject", cards[5].edit_id));
  check("accept the bold", await ok("accept", cards[4].edit_id));
  const after = await msc.active();
  const line = (id: string) => {
    const b = after.byId.get(id);
    return b && b.kind === "paragraph" ? renderInlines(b.inlines) : "";
  };
  console.log(`0000011B: ${line("0000011B").slice(0, 100)}\n00000124+1: ${line("00000124+1")}\n00000122: ${line("00000122").slice(0, 120)}`);
  check("accepted replace reads as plain text", line("0000011B").startsWith("perform its obligations under the Contract"));
  check("accepted insert keeps its id; only the second turn's words are pending", line("00000124+1") === "provide the Authority with a {++detailed ++}monthly service report.");
  check("rejected footnote is gone", !line("00000122").includes("[^"));
  check("range delete still pending", (after.byId.get(rangeFrom) as { markRevision?: string }).markRevision === "del");

  section("a batch with one bad target changes nothing");
  msc.newTurn();
  const versionsBefore = (await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", msc.documentId)).count;
  const activeBefore = await loadActiveVersion(msc.documentId, db);
  const bad = await msc.tool("edit_document", {
    doc_id: "doc-0",
    edits: [
      { op: "replace", block: "00000125", find: "as soon as practicable", replace: "promptly" },
      { op: "replace", block: "NOT-A-BLOCK", find: "x", replace: "y" },
    ],
  });
  console.log(bad.content);
  const versionsAfter = (await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", msc.documentId)).count;
  const activeAfter = await loadActiveVersion(msc.documentId, db);
  check("bad batch reported as failed", JSON.parse(bad.content).ok === false);
  check("no new version, active version unchanged", versionsBefore === versionsAfter && activeBefore?.storage_path === activeAfter?.storage_path);

  // -------------------------------------------------------------------------
  section("Part 2: ids across versions (academy agreement, ordinal ids)");
  const ac = await setup("uk-academy-commercial-transfer-agreement-2013.docx", "Academy CTA.docx");
  const p20before = (await ac.tool("read_document", { doc_id: "doc-0", from: "p20", to: "p20" })).content.split("\n").find((l) => l.startsWith("[p20]"));
  console.log(p20before);
  const e2 = await ac.tool("edit_document", { doc_id: "doc-0", edits: [{ op: "insert", after: "p19", paragraphs: ["(1A) a new party"] }] });
  check("insert applied", JSON.parse(e2.content).ok === true);
  check("accept the insert", await (async () => (await resolveEdit("accept", ac.documentId, e2.res.docsEdited[0].annotations[0].edit_id, userId, email, db)).ok)());
  ac.newTurn();
  const after2 = (await ac.tool("read_document", { doc_id: "doc-0", from: "p19", to: "p20" })).content;
  console.log(after2.split("\n").filter((l) => /^\[p(19|20)/.test(l)).join("\n"));
  check("p20 still names the same paragraph", after2.split("\n").find((l) => l.startsWith("[p20]")) === p20before);
  check("the accepted paragraph keeps its id", after2.includes("[p19+1] (1A) a new party"));

  console.log(process.exitCode ? "\nPROBE FAILED" : "\nPROBE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
