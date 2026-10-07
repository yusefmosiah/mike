// Mission 1b probe: tracked-change editing through the real tool dispatcher.
//
// Runs against a local stack (docker compose up -d db auth rest gateway
// db-init mailpit storage createbucket) with the well-known local keys:
//
//   cd backend && npx tsx scripts/probe-docx-editing.ts
//
// It uploads the UK Model Services Contract core terms, then does what a
// model would: read_document, find_in_document, one edit_document batch with
// a replace, an insert, a range delete across a table and an empty-paragraph
// delete, then get_diff. It accepts one change and rejects another through
// the documents service and reads the result back, and finally sends a batch
// with one bad target and checks that nothing changed.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= LOCAL_SERVICE_KEY;
process.env.R2_ENDPOINT_URL ??= "http://localhost:9000";
process.env.R2_ACCESS_KEY_ID ??= "rustfsadmin";
process.env.R2_SECRET_ACCESS_KEY ??= "rustfsadmin";
process.env.R2_BUCKET_NAME ??= "mike";
process.env.DOWNLOAD_SIGNING_SECRET ??= "probe-download-signing-secret-not-for-production";

const FIXTURE = path.resolve(__dirname, "../src/__tests__/fixtures/docx/public-legal/uk-msc-core-terms-v2.2a.docx");

function section(title: string) {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);
}

function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const { createServerSupabase } = await import("../src/lib/supabase");
  const { uploadFile, downloadFile } = await import("../src/lib/storage");
  const { createDocumentVersion, resolveEdit } = await import("../src/modules/documents/documents.service");
  const { runToolCalls } = await import("../src/modules/chat/engine/tools/toolDispatcher");
  const { DocxDocument } = await import("../src/lib/docx/view");
  const { renderInlines } = await import("../src/lib/docx/render");
  const { loadActiveVersion } = await import("../src/lib/documentVersions");

  const db = createServerSupabase();

  // A user, a document, and its first version.
  const email = `probe-${Date.now()}@mike.local`;
  const { data: created, error: userErr } = await db.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
  if (userErr || !created.user) throw new Error(`createUser: ${userErr?.message}`);
  const userId = created.user.id;
  const bytes = readFileSync(FIXTURE);
  const { data: docRow, error: docErr } = await db.from("documents").insert({ user_id: userId, status: "ready" }).select("id").single();
  if (docErr || !docRow) throw new Error(`documents insert: ${docErr?.message}`);
  const documentId = docRow.id as string;
  const storagePath = `documents/${userId}/${documentId}/source.docx`;
  await uploadFile(storagePath, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { data: v1, error: vErr } = await createDocumentVersion(db, {
    document_id: documentId,
    storage_path: storagePath,
    source: "upload",
    filename: "MSC Core Terms.docx",
    file_type: "docx",
    size_bytes: bytes.byteLength,
    page_count: null,
    content_sha256: null,
  } as never);
  if (vErr || !v1) throw new Error(`createDocumentVersion: ${vErr?.message}`);
  console.log(`document ${documentId}, version ${v1.version_number}`);

  const docStore = new Map([["doc-0", { storage_path: storagePath, file_type: "docx", filename: "MSC Core Terms.docx" }]]);
  const docIndex: Record<string, { document_id: string; filename: string; version_id?: string | null; version_number?: number | null }> = {
    "doc-0": { document_id: documentId, filename: "MSC Core Terms.docx", version_id: v1.id, version_number: v1.version_number },
  };
  const events: string[] = [];
  const turnEditState = new Map();
  const turnReadState = new Map();
  let call = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await runToolCalls(
      [{ id: `call-${++call}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] as never,
      docStore as never,
      userId,
      db,
      (s) => events.push(s),
      undefined,
      undefined,
      docIndex as never,
      turnEditState as never,
      turnReadState as never,
    );
    const content = (res.toolResults[0] as { content: string }).content;
    return { res, content };
  };

  section("read_document (default)");
  const read = await tool("read_document", { doc_id: "doc-0" });
  console.log(read.content.slice(0, 1500));

  section("find_in_document");
  const found = await tool("find_in_document", { doc_id: "doc-0", query: "under this Contract" });
  console.log(found.content.slice(0, 800));

  // Pick targets the way a model would from what it read.
  const view = await DocxDocument.load(bytes);
  const t = view.blocks.findIndex((b, i) => b.kind === "table" && view.blocks[i - 1]?.kind === "paragraph" && view.blocks[i + 1]?.kind === "paragraph");
  const rangeFrom = view.blocks[t - 1].id;
  const rangeTo = view.blocks[t + 1].id;
  const empty = view.blocks.find((b, i) => i > t + 5 && b.kind === "paragraph" && b.text.trim() === "" && i < view.blocks.length - 1)!;

  section("read_document (section 5.3)");
  const sec = await tool("read_document", { doc_id: "doc-0", section: "5.3" });
  console.log(sec.content.slice(0, 1200));

  section("edit_document: replace + insert + range delete across a table + empty paragraph");
  const batch = [
    { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract", reason: "Consistent defined usage" },
    { op: "insert", after: "00000124", paragraphs: ["provide the Authority with a monthly service report."], reason: "New reporting obligation" },
    { op: "delete", block: rangeFrom, through: rangeTo, reason: "Remove the version table and its notes" },
    { op: "delete", block: empty.id, reason: "Stray empty paragraph" },
  ];
  const edit = await tool("edit_document", { doc_id: "doc-0", edits: batch });
  console.log(edit.content.slice(0, 1500));
  const editResult = JSON.parse(edit.content) as { ok: boolean; version_number?: number };
  check("edit batch applied", editResult.ok === true);
  const annotations = edit.res.docsEdited[0]?.annotations ?? [];
  console.log(annotations.map((a) => `card ${a.edit_id}: -${JSON.stringify(a.deleted_text.slice(0, 60))} +${JSON.stringify(a.inserted_text.slice(0, 60))}`).join("\n"));
  check("one card per edit", annotations.length === 4);

  section("get_diff");
  const diff = await tool("get_diff", { doc_id: "doc-0" });
  console.log(diff.content.slice(0, 2000));
  const diffJson = JSON.parse(diff.content) as { changes: unknown[]; lint: { valid: boolean } };
  check("get_diff lists the four changes", diffJson.changes.length === 4);
  check("get_diff lint valid", diffJson.lint.valid === true);

  section("read_document after the edit");
  const reread = await tool("read_document", { doc_id: "doc-0", from: "0000011B", to: "00000125" });
  console.log(reread.content.slice(0, 1500));
  check("edited read shows the tracked replace", reread.content.includes("{--this--}{++the++}"));
  check("edited read shows the inserted paragraph under its anchor id", /\[00000124\+1\][^\n]*\{\+\+provide the Authority with a monthly service report\.\+\+\}/.test(reread.content));

  section("accept the replace, reject the insert (documents service)");
  const acc = await resolveEdit("accept", documentId, annotations[0].edit_id, userId, email, db);
  const rej = await resolveEdit("reject", documentId, annotations[1].edit_id, userId, email, db);
  console.log(JSON.stringify({ accept: acc.ok, reject: rej.ok }));
  check("accept ok", acc.ok);
  check("reject ok", rej.ok);
  const active = await loadActiveVersion(documentId, db);
  const after = await DocxDocument.load(Buffer.from((await downloadFile(active!.storage_path))!));
  const line = (id: string) => {
    const b = after.byId.get(id);
    return b && b.kind === "paragraph" ? renderInlines(b.inlines) : "";
  };
  console.log(`0000011B: ${line("0000011B").slice(0, 120)}`);
  check("accepted replace reads as plain text", line("0000011B").startsWith("perform its obligations under the Contract") && !line("0000011B").includes("{"));
  check("rejected insert is gone", !after.paragraphs.some((p) => p.text.includes("monthly service report")));
  check("range delete still pending", after.byId.get(rangeFrom)?.kind === "paragraph" && (after.byId.get(rangeFrom) as { markRevision?: string }).markRevision === "del");
  check("empty-paragraph delete still pending", (after.byId.get(empty.id) as { markRevision?: string }).markRevision === "del");

  section("a batch with one bad target changes nothing");
  const { count: before } = await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", documentId);
  const activeBefore = await loadActiveVersion(documentId, db);
  turnEditState.clear();
  const bad = await tool("edit_document", {
    doc_id: "doc-0",
    edits: [
      { op: "replace", block: "00000125", find: "as soon as practicable", replace: "promptly" },
      { op: "replace", block: "NOT-A-BLOCK", find: "x", replace: "y" },
    ],
  });
  console.log(bad.content);
  const { count: afterCount } = await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", documentId);
  const activeAfter = await loadActiveVersion(documentId, db);
  check("bad batch reported as failed", JSON.parse(bad.content).ok === false);
  check("no new version", before === afterCount);
  check("active version unchanged", activeBefore?.id === activeAfter?.id && activeBefore?.storage_path === activeAfter?.storage_path);

  console.log(process.exitCode ? "\nPROBE FAILED" : "\nPROBE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
