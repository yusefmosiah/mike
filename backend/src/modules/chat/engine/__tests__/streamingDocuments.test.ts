import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `docs` in code mode: a cell asks the host for the turn's documents over
// the kernel channel. These pin that the host lists and loads only the
// turn's own documents (never the Word add-in's request-scoped text, never
// an id outside the turn), and that loading records one "Read" line per
// document version however many cells use it.

const files: Record<string, string> = {
  "store/lease.md": "# Lease\n\n## 4. Rent\n\nRent is due monthly in advance.\n\n## 9. Termination\n\nEither party may end this lease on 90 days' notice.",
  "store/memo.txt": "The landlord disputes the notice period.",
};

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/storage")>()),
  downloadFile: vi.fn(async (key: string) => (key in files ? Buffer.from(files[key]) : null)),
}));

import { kernels } from "../../../../lib/codemode";
import { runLLMStream } from "../streaming";
import { PROJECT_EXTRA_TOOLS } from "../tools/toolSchemas";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string }[]>;
type StreamChatCall = { runTools?: RunToolsFn; [key: string]: unknown };

const docStore = new Map<string, Record<string, unknown>>([
  ["doc-0", { filename: "Lease.md", file_type: "md", storage_path: "store/lease.md" }],
  ["doc-1", { filename: "Memo.txt", file_type: "txt", storage_path: "store/memo.txt" }],
  ["doc-2", { filename: "Open in Word.docx", file_type: "docx", storage_path: "", inline_text: "Request-scoped words." }],
]);

/** Runs one turn of Python cells; returns each cell's output and the streamed lines. */
async function turn(...codes: string[]) {
  const write = vi.fn();
  let results: Awaited<ReturnType<RunToolsFn>> = [];
  streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
    for (const [i, code] of codes.entries()) {
      results = results.concat((await params.runTools?.([{ id: `p${i}`, name: "run_python", input: { code } }])) ?? []);
    }
    return { fullText: "" };
  });
  await runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "review" }],
    docStore,
    docIndex: {},
    userId: "u1",
    chatId: "chat-docs",
    db: {} as never,
    write,
    extraTools: PROJECT_EXTRA_TOOLS,
  } as never);
  const lines = write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((chunk) => chunk.startsWith("data: {"))
    .map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; filename?: string });
  return { outputs: results.map((r) => r.content), lines };
}

const kernelDir = mkdtempSync(path.join(tmpdir(), "mike-kernel-"));
beforeEach(() => vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", kernelDir));
afterEach(() => vi.unstubAllEnvs());
afterAll(() => kernels.closeAll());

describe("docs in code mode", () => {
  it("lists and loads only the turn's documents, recording one read per document", async () => {
    const { outputs, lines } = await turn(
      `print(docs.ids())
print(docs["doc-0"].section("9").text)`,
      `print(docs.find("lease").outline())
print([h.block.id for h in docs.grep("notice")])`,
    );
    expect(outputs[0]).toContain("['doc-0', 'doc-1']");
    expect(outputs[0]).toContain("Either party may end this lease on 90 days' notice.");
    expect(outputs[1]).toContain("9. Termination");
    expect(outputs[1]).toContain("['m9', 'm1']");
    const reads = lines.filter((line) => line.type === "doc_read").map((line) => line.filename);
    expect(reads).toEqual(["Lease.md", "Memo.txt"]);
  });

  it("refuses the Word add-in's document and ids outside the turn, even asked for directly", async () => {
    const { outputs, lines } = await turn(
      `from mike_kernel import docs as d
for doc_id in ["doc-2", "doc-9"]:
    try:
        d._host({"op": "load", "doc_id": doc_id})
    except LookupError as e:
        print(e)`,
    );
    expect(outputs[0]).toContain("doc-2 is the document open in Word; read it with tools.read_document.");
    expect(outputs[0]).toContain("No document 'doc-9' here.");
    expect(lines.filter((line) => line.type === "doc_read")).toEqual([]);
  });
});
