import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localKernelLauncher } from "../kernel/manager";
import { KernelSession, type HostReply } from "../kernel/session";
import { markdownToModel } from "../../documentModel";

// Python's `docs` over the host channel (goals/mission-14-document-model.md):
// the list and each document's common model come from the host, and the
// reading, searching and citing all happen in the kernel.

const memo = markdownToModel(
  [
    "# Services Agreement",
    "",
    "## 1. Definitions",
    "",
    "\"Services\" means the consulting services described in Schedule 1.",
    "",
    "## 12. Limitation of liability",
    "",
    "12.1 Neither party's total liability shall exceed the fees paid in the twelve months before the claim.",
    "",
    "12.2 Nothing limits liability for fraud or death caused by negligence.",
    "",
    "| Item | Fee |",
    "| --- | --- |",
    "| Setup | $2,000 |",
    "| Monthly | $500 |",
  ].join("\n"),
);
const pdfLike = {
  format: "pdf",
  pages: 2,
  warnings: ["Some headings were recognised by their type size or capitals; they are marked inferred."],
  blocks: [
    { id: "p1.1", kind: "heading", level: 1, text: "MARKET REPORT", page: 1, inferred: true },
    { id: "p1.2", kind: "paragraph", text: "The regional market for private AI installs is growing.", page: 1 },
    { id: "p2.1", kind: "paragraph", text: "Liability caps in consulting contracts are usually twelve months of fees.", page: 2 },
  ],
};
const documents: Record<string, unknown> = {
  "doc-0": { doc_id: "doc-0", filename: "Services Agreement.md", version_id: "v1", ...memo },
  "doc-1": { doc_id: "doc-1", filename: "market_report.pdf", version_id: "v7", ...pdfLike },
};
const requests: Array<Record<string, unknown>> = [];

const host = async (data: Record<string, unknown>): Promise<HostReply> => {
  requests.push(data);
  if (data.type !== "documents") return { ok: false, error: "no tools here" };
  if (data.op === "list") {
    return {
      ok: true,
      content: JSON.stringify([
        { doc_id: "doc-0", filename: "Services Agreement.md", file_type: "md", version_id: "v1" },
        { doc_id: "doc-1", filename: "market_report.pdf", file_type: "pdf", version_id: "v7" },
      ]),
    };
  }
  const doc = documents[String(data.doc_id)];
  return doc ? { ok: true, content: JSON.stringify(doc) } : { ok: false, error: "No document." };
};

let session: KernelSession;
const run = async (code: string) => {
  const outcome = await session.execute(code, { timeoutMs: 20_000, onHostRequest: host });
  if (outcome.status !== "ok") throw new Error(`${outcome.error?.ename}: ${outcome.error?.evalue}\n${outcome.stdout}`);
  return outcome.stdout + (outcome.result ? `${outcome.result}\n` : "");
};

beforeAll(async () => {
  const launcher = localKernelLauncher(mkdtempSync(path.join(tmpdir(), "mike-docs-test-")));
  session = await KernelSession.start(launcher.spawn);
  await session.configure([]);
});
afterAll(() => session.kill());

describe("docs in Python", () => {
  it("lists the documents and loads one only when it is touched", async () => {
    requests.length = 0;
    const listing = await run("print(docs)");
    expect(listing).toContain("2 documents:");
    expect(listing).toContain("doc-1  market_report.pdf");
    expect(requests.filter((r) => r.op === "load")).toEqual([]);
    const shape = await run("d = docs['doc-0']\nprint(repr(d))");
    expect(shape).toMatch(/<doc-0 'Services Agreement.md': markdown, \d+ blocks, [\d,]+ chars, 3 headings>/);
    await run("docs['doc-0'].outline()");
    expect(requests.filter((r) => r.op === "load")).toEqual([{ type: "documents", op: "load", doc_id: "doc-0" }]);
  });

  it("outlines, slices and finds sections", async () => {
    const outline = await run("print(docs['doc-0'].outline())");
    expect(outline).toContain("[m1] Services Agreement");
    expect(outline).toContain("  [m7] 12. Limitation of liability");
    const section = await run("print(docs['doc-0'].section('12'))");
    expect(section).toContain("[m9] 12.1 Neither party's total liability");
    expect(section).toContain("table, 3 rows");
    const range = await run("print(docs['doc-0']['m3':'m5'])");
    expect(range.trim().split("\n")).toEqual([
      "[m3] ## 1. Definitions",
      "[m5] \"Services\" means the consulting services described in Schedule 1.",
    ]);
    expect(await run("print(docs['doc-1'].page(2))")).toContain("[Page 2]\n[p2.1] Liability caps");
    expect(await run("print(docs['doc-1'].outline())")).toContain("(inferred)");
  });

  it("greps and ranks across documents", async () => {
    const grep = await run("print(docs.grep(r'twelve\\s+months'))");
    expect(grep).toContain("doc-0 [m9] § 12. Limitation of liability: ");
    expect(grep).toContain("doc-1 [p2.1] p.2 § MARKET REPORT: Liability caps");
    const ranked = await run("hits = docs.search('liability cap fees', k=3)\nprint(hits[0].doc.id, hits[0].block.id)");
    expect(["doc-0 m9", "doc-1 p2.1"]).toContain(ranked.trim());
    expect(await run("print(docs['doc-0'].tables[0].rows)")).toContain("[['Item', 'Fee'], ['Setup', '$2,000'], ['Monthly', '$500']]");
    // The workstation has pandas; a CI runner may not.
    const fees = await run(`import importlib.util
t = docs['doc-0'].tables[0]
print(t.df.to_csv(index=False).strip() if importlib.util.find_spec("pandas") else "no pandas")`);
    if (fees.trim() !== "no pandas") expect(fees.trim()).toBe("Item,Fee\nSetup,\"$2,000\"\nMonthly,$500");
  });

  it("checks a quote is verbatim before it is cited", async () => {
    expect(await run("docs['doc-1'].quote('p2.1', 'usually  twelve months')")).toContain("{'page': 2, 'quote': 'usually twelve months'}");
    expect(await run("docs['doc-0'].quote('m9', 'fees paid in the twelve months')")).toContain("{'quote': 'fees paid in the twelve months'}");
    const wrong = await session.execute("docs['doc-0'].quote('m9', 'fees paid in the last year')", { timeoutMs: 10_000, onHostRequest: host });
    expect(wrong.error).toMatchObject({ ename: "ValueError" });
    expect(wrong.error?.evalue).toContain("Not verbatim in [m9]");
  });

  it("reports a document the host refuses", async () => {
    const missing = await session.execute("docs['doc-9']", { timeoutMs: 10_000, onHostRequest: host });
    expect(missing.error).toMatchObject({ ename: "KeyError" });
  });
});
