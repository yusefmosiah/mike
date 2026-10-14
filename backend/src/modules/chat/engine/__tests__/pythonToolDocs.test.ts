import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { localKernelLauncher } from "../../../../lib/codemode/kernel/manager";
import { KernelSession } from "../../../../lib/codemode/kernel/session";
import { pythonParamName, pythonToolDoc, pythonToolSpecs } from "../../../../lib/codemode/python";
import { COURTLISTENER_TOOLS } from "../tools/courtlistenerTools";
import {
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
});
