import { expect, it, vi } from "vitest";

// Reading several documents at once shares one character budget, a PDF
// window stops at its size as well as its line count, and find_in_documents
// searches many documents in one call.

const texts: Record<string, string> = {};
vi.mock("../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/storage")>()),
  downloadFile: vi.fn(async (path: string) => Buffer.from(path)),
}));
vi.mock("../../../../lib/pdfText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/pdfText")>()),
  extractPdfText: vi.fn(async (raw: Uint8Array) => texts[Buffer.from(raw).toString()] ?? ""),
}));

import { FETCH_DOCUMENTS_BUDGET_CHARS, fetchWindowChars, runToolCalls } from "../tools/toolDispatcher";

const pdf = (name: string, text: string) => {
  texts[name] = text;
  return { filename: `${name}.pdf`, file_type: "pdf", storage_path: name };
};
const longText = (marker: string) =>
  Array.from({ length: 1500 }, (_, i) => `${marker} line ${i + 1}: ${"x".repeat(60)}`).join("\n");

const docStore = new Map<string, ReturnType<typeof pdf>>([
  ["doc-0", pdf("brief", `${longText("brief")}\nThe indemnity cap is $2m.`)],
  ["doc-1", pdf("report", longText("report"))],
  ["doc-2", pdf("memo", "Short memo. The indemnity cap is disputed.\nSecond indemnity mention.")],
]);
const call = (name: string, args: Record<string, unknown>) => [{ id: "c1", function: { name, arguments: JSON.stringify(args) } }];
const run = (name: string, args: Record<string, unknown>) =>
  runToolCalls(call(name, args), docStore as never, "u1", undefined as never, vi.fn());
const content = (result: Awaited<ReturnType<typeof run>>) => (result.toolResults[0] as { content: string }).content;

it("splits one budget between the documents a fetch reads", async () => {
  expect(fetchWindowChars(1)).toBe(40_000);
  expect(fetchWindowChars(5)).toBe(12_000);
  expect(fetchWindowChars(30)).toBe(8_000);
  const text = content(await run("fetch_documents", { doc_ids: ["doc-0", "doc-1", "doc-2"] }));
  expect(text.length).toBeLessThan(FETCH_DOCUMENTS_BUDGET_CHARS + 6_000);
  expect(text).toContain("Short memo.");
  expect(text.match(/Showing lines 1–\d+ of 1501\. Call read_document/)).not.toBeNull();
});

it("finds which documents mention something, without reading them", async () => {
  const found = JSON.parse(content(await run("find_in_documents", { query: "indemnity", max_results_per_document: 1 })));
  expect(found).toMatchObject({ ok: true, searched: 3, total_matches: 3 });
  expect(found.documents.map((d: { doc_id: string; total_matches: number }) => [d.doc_id, d.total_matches])).toEqual([
    ["doc-0", 1],
    ["doc-2", 2],
  ]);
  expect(found.documents[1].hits).toHaveLength(1);
  const some = JSON.parse(content(await run("find_in_documents", { query: "report line 7:", doc_ids: ["doc-1", "doc-9"] })));
  expect(some).toMatchObject({ searched: 1, total_matches: 1, skipped: [{ doc_id: "doc-9", reason: "not found" }] });
});
