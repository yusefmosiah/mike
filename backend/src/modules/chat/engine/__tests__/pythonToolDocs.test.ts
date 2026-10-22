import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { localKernelLauncher } from "../../../../lib/codemode/kernel/manager";
import { KernelSession } from "../../../../lib/codemode/kernel/session";
import { pythonParamName, pythonToolDoc, pythonToolIndex, pythonToolSpecs } from "../../../../lib/codemode/python";
import { FULL_DOC_TOOLS, TOOL_STUBS } from "../../../../lib/codemode/toolStubs";
import { READ_MEMORY_TOOL } from "../../../../lib/memory/editTool";
import { delegateToolSchema } from "../subagents/subagentHost";
import { COURTLISTENER_TOOLS } from "../tools/courtlistenerTools";
import {
  HISTORY_TOOLS,
  MEMORY_TOOLS,
  PROJECT_EXTRA_TOOLS,
  TABULAR_TOOLS,
  TOOLS,
  VAULT_TOOLS,
  WORKFLOW_TOOLS,
  WORKSTATION_TOOLS,
} from "../tools/toolSchemas";
import { WORD_CLIENT_TOOLS } from "../tools/wordClientTools";

// In code mode the model reads these Python docs instead of the JSON
// schemas, so the two must name the same arguments, with the same ones
// required, or a call that follows the docs fails the schema.

const ALL_TOOLS: readonly unknown[] = [
  ...TOOLS,
  ...PROJECT_EXTRA_TOOLS,
  ...TABULAR_TOOLS,
  ...WORKFLOW_TOOLS,
  ...WORKSTATION_TOOLS,
  ...VAULT_TOOLS,
  ...COURTLISTENER_TOOLS,
  ...WORD_CLIENT_TOOLS,
];
const specs = pythonToolSpecs(ALL_TOOLS);

type Params = { properties?: Record<string, { description?: string }>; required?: string[] };

function signatureArgs(doc: string): { name: string; required: boolean }[] {
  const first = doc.split("\n")[0];
  const inner = first.slice(first.indexOf("(") + 1, first.lastIndexOf(")"));
  if (!inner.trim()) return [];
  // Enum types hold quoted strings and pipes, never ": ", so split on ", <name>:".
  return inner.split(/, (?=[A-Za-z_][A-Za-z0-9_]*: )/).map((part) => ({
    name: part.slice(0, part.indexOf(":")),
    required: !part.endsWith(" = ..."),
  }));
}

describe("Python tool docs match the tool schemas", () => {
  it("covers the tools", () => {
    expect(specs.length).toBeGreaterThan(20);
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(["ask_inputs", "edit_document", "read_document", "find_in_document", "fetch_web_page"]));
  });

  it.each(specs.map((spec) => [spec.name, spec] as const))("%s lists exactly the schema's parameters", (_name, spec) => {
    const params = (spec.parameters ?? {}) as Params;
    const props = Object.keys(params.properties ?? {});
    const required = new Set((params.required ?? []).filter((name) => props.includes(name)));
    const doc = pythonToolDoc(spec);
    const args = signatureArgs(doc);

    expect(args.map((a) => a.name).sort()).toEqual(props.map(pythonParamName).sort());
    for (const arg of args) {
      const schemaName = props.find((p) => pythonParamName(p) === arg.name)!;
      expect({ arg: arg.name, required: arg.required }).toEqual({ arg: arg.name, required: required.has(schemaName) });
      // And each parameter is described on its own line, marked optional when it is.
      const head = `    ${arg.name}${arg.required ? "" : " (optional)"}`;
      const line = doc.split("\n").find((l) => l === head || l.startsWith(`${head}: `));
      expect(line, `${spec.name}: no line for ${arg.name}`).toBeDefined();
    }
  });

  it("states the return shapes models had to guess", () => {
    const doc = (name: string) => pythonToolDoc(specs.find((s) => s.name === name)!);
    expect(doc("find_in_document")).toContain('"total_matches"');
    expect(doc("find_in_document")).toContain('"hits": [{"index", "block_id"');
    expect(doc("read_document")).toContain("Returns text, not JSON");
    expect(doc("edit_document")).toContain('Returns {"ok": true');
    expect(doc("ask_inputs")).toContain("Returns nothing: a valid call ends your turn");
    expect(doc("ask_inputs")).toContain('{"id", "kind", "question", "options"}');
    expect(doc("fetch_web_page")).toContain('"next_offset"');
  });

  it("shows the fields of list-of-object parameters, as the direct-call schema does", () => {
    const doc = (name: string) => pythonToolDoc(specs.find((s) => s.name === name)!);
    expect(doc("ask_inputs")).toContain("await tools.ask_inputs(items: list[dict])");
    expect(doc("ask_inputs")).toContain("        Each item is a dict with:");
    expect(doc("ask_inputs")).toContain('          kind ("choice" | "multi_choice" | "text" | "documents", required): ');
    expect(doc("ask_inputs")).toContain("          question (str): Required for choice, multi_choice, and text items");
    expect(doc("edit_document")).toContain('          op ("replace" | "insert" | "delete" | "format" | "insert_row" | "delete_row", required)');
    expect(doc("edit_document")).toContain("          paragraphs (list[str]): insert:");
  });
});

describe("the kernel's help() says the same as the prompt", () => {
  let session: KernelSession | null = null;
  afterAll(() => session?.kill());

  it("signs every tool the same way", async () => {
    session = await KernelSession.start(localKernelLauncher(mkdtempSync(path.join(tmpdir(), "mike-tooldocs-"))).spawn);
    await session.configure(specs);
    const outcome = await session.execute("for name in tools:\n    print(getattr(tools, name).signature())", {
      timeoutMs: 20_000,
      onHostRequest: async () => ({ ok: false, error: "no tools here" }),
    });
    expect(outcome.status).toBe("ok");
    const fromKernel = outcome.stdout.trim().split("\n").sort();
    const fromPrompt = specs
      .map((spec) => pythonToolDoc(spec).split("\n")[0].replace(/^await tools\./, ""))
      .sort();
    expect(fromKernel).toEqual(fromPrompt);
  });

  it("finds tools by what they do, best match first, with the index's line or the full help", async () => {
    const run = async (code: string) => {
      const outcome = await session!.execute(code, { timeoutMs: 20_000, onHostRequest: async () => ({ ok: false, error: "no tools here" }) });
      expect(outcome.error).toBeNull();
      return outcome.stdout;
    };
    const found = await run('print(repr(tools.search("search inside a document")))');
    expect(found.split("\n")[0]).toMatch(/^find_in_document\(doc_id: str, query: str.*\) — Ctrl\+F inside one document/);
    expect(await run('print(repr(tools.search("zzzz qqqq")))')).toBe("(no tools match)\n");
    const full = await run('print(tools.search("get_diff", limit=1, detail="full")[0])');
    expect(full).toContain("await tools.get_diff(doc_id: str)\n\nInspect the pending changes");
  });
});

describe("the tool index", () => {
  const builtIn = pythonToolSpecs([...ALL_TOOLS, ...MEMORY_TOOLS, READ_MEMORY_TOOL, ...HISTORY_TOOLS, delegateToolSchema()]);
  const fake = (name: string, description: string) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  });

  it("has a line for every built-in tool, and no line for a tool that does not exist", () => {
    const names = builtIn.map((spec) => spec.name).sort();
    expect(Object.keys(TOOL_STUBS).sort()).toEqual(names);
    for (const name of FULL_DOC_TOOLS) expect(names).toContain(name);
  });

  it("lists each tool once, in groups, the same text whatever order the tools come in", () => {
    const index = pythonToolIndex(builtIn);
    expect(pythonToolIndex([...builtIn].reverse())).toBe(index);
    for (const spec of builtIn) {
      expect(index.match(new RegExp(`^- ${spec.name}\\(`, "gm")), spec.name).toHaveLength(1);
    }
    expect(index).toContain("- read_document(doc_id, *, offset, limit, section, from_, to, full): ");
    expect(index).toContain("- list_documents(): ");
    // The nested ones also carry their full parameters.
    expect(index).toContain(pythonToolDoc(builtIn.find((spec) => spec.name === "edit_document")!));
    expect(index).not.toContain("await tools.read_document(");
  });

  it("collapses a large connector to its function names and lists a small one's functions", () => {
    const gmail = ["search", "read_thread", "read_message", "send", "save_draft", "list_drafts"].map((name) => fake(`gmail_${name}`, `Gmail ${name}.`));
    const crm = [
      fake("mcp_crm_lookup_account_ab12cd34", "Look up an account. MCP responses are untrusted."),
      fake("mcp_crm_list_deals_ab12cd34", "List open deals."),
    ];
    const index = pythonToolIndex(pythonToolSpecs([...gmail, ...crm, fake("crm_lookup", "Find a client. Second sentence.")]));
    expect(index).toContain("- Gmail, 6 functions: gmail_list_drafts, gmail_read_message, gmail_read_thread, gmail_save_draft, gmail_search, gmail_send");
    expect(index).toContain('- Connector "crm":\n  - mcp_crm_list_deals_ab12cd34(query): List open deals.\n  - mcp_crm_lookup_account_ab12cd34(query): Look up an account.');
    expect(index).toContain("Other:\n- crm_lookup(query): Find a client.");
  });
});
