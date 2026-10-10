/**
 * Code mode with Python (goals/mission-11-code-mode.md): the `run_python`
 * tool, the tool index the model reads, and the text it gets back.
 *
 * Every tool the conversation has becomes `await tools.<name>(...)` in a
 * persistent Python kernel inside the employee's workstation VM. Each call a
 * cell makes comes back to the harness and runs exactly as a direct call
 * would: same permissions, same events in the chat, same write ordering.
 */
import type { CellOutcome, KernelToolSpec } from "./kernel/session";

export const RUN_PYTHON_TOOL = "run_python";
export const DEFAULT_CELL_TIMEOUT_MS = 300_000;
export const MAX_CELL_TIMEOUT_MS = 60 * 60_000;

/** Tools never offered inside Python: run_python itself, and run_command, which subprocess replaces. */
export const NOT_IN_PYTHON: ReadonlySet<string> = new Set([RUN_PYTHON_TOOL, "run_command"]);

export const RUN_PYTHON_SCHEMA = {
  type: "function",
  function: {
    name: RUN_PYTHON_TOOL,
    description:
      "Run Python in the user's workstation: a persistent kernel, like a Jupyter notebook, where variables, imports and functions stay defined across calls and across messages in this conversation. It is how you use every tool you have: call them as `await tools.<name>(...)` (see TOOLS IN PYTHON in your instructions). Only what the code prints, and the value of its last line, come back to you, so print what you need to see and summarize large results in code. Top-level await works; run independent calls together with `await tools.gather(...)`. The machine is Linux with a persistent home directory, network access, and pandas, openpyxl, python-docx and requests; subprocess runs shell commands.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python source to run, as a notebook cell." },
        timeout_seconds: {
          type: "number",
          description: "Time limit for the code's own running time, not counting tool calls (default 300, at most 3600).",
        },
        reset: {
          type: "boolean",
          description: "Start a fresh kernel first, discarding every variable. Rarely needed.",
        },
      },
      required: ["code"],
    },
  },
} as const;

type FunctionSchema = { function?: { name?: string; description?: string; parameters?: unknown } };

/** The specs the kernel binds as `tools.<name>`. */
export function pythonToolSpecs(tools: readonly unknown[]): KernelToolSpec[] {
  const specs: KernelToolSpec[] = [];
  for (const tool of tools as FunctionSchema[]) {
    const fn = tool?.function;
    if (!fn?.name || NOT_IN_PYTHON.has(fn.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn.name)) continue;
    specs.push({ name: fn.name, description: fn.description ?? "", parameters: fn.parameters ?? {} });
  }
  return specs;
}

type JsonSchema = { type?: unknown; enum?: unknown; description?: unknown };

const JSON_TYPES: Record<string, string> = {
  string: "str",
  integer: "int",
  number: "float",
  boolean: "bool",
  array: "list",
  object: "dict",
  null: "None",
};

function typeName(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.map((t) => JSON_TYPES[String(t)] ?? String(t)).join(" | ");
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 8).map((v) => JSON.stringify(v)).join(" | ");
  return typeof schema.type === "string" ? (JSON_TYPES[schema.type] ?? "Any") : "Any";
}

/** One tool as Python documentation; the kernel's help(tools.x) says the same. */
export function pythonToolDoc(spec: KernelToolSpec): string {
  const params = (spec.parameters ?? {}) as { properties?: Record<string, JsonSchema>; required?: unknown };
  const props = params.properties && typeof params.properties === "object" ? params.properties : {};
  const required = (Array.isArray(params.required) ? params.required : []).filter(
    (name): name is string => typeof name === "string" && name in props,
  );
  const order = [...required, ...Object.keys(props).filter((name) => !required.includes(name))];
  const signature = order
    .map((name) => `${name}: ${typeName(props[name] ?? {})}${required.includes(name) ? "" : " = ..."}`)
    .join(", ");
  const lines = [`await tools.${spec.name}(${signature})`];
  if (spec.description) lines.push(indent(spec.description.trim()));
  for (const name of order) {
    const text = typeof props[name]?.description === "string" ? (props[name].description as string).trim() : "";
    lines.push(`    ${name}${required.includes(name) ? "" : " (optional)"}${text ? `: ${text}` : ""}`);
  }
  return lines.join("\n");
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/** The system prompt section that replaces the tools' own schemas. */
export function pythonToolsPromptSection(specs: KernelToolSpec[]): string {
  return [
    "TOOLS IN PYTHON:",
    "Your tools are Python functions, called from run_python. Wherever these instructions name a tool (read_document, edit_document, ask_inputs and the rest), call it as `await tools.<name>(...)` inside run_python, with the same arguments. Arguments are keyword arguments (required ones may also be positional). A result that is JSON comes back parsed (dict or list), otherwise as a string. A tool that fails raises ToolError; catch it to recover. A question to the user (ask_inputs, or an approval) ends the turn: the user's answer arrives in the next message, and your variables are still there.",
    "Print only what you need to read. Keep large intermediate data in variables and files rather than printing it. For several independent calls use `await tools.gather(tools.a(...), tools.b(...))`.",
    "",
    ...specs.map(pythonToolDoc),
  ].join("\n");
}

/** The tool result the model reads for one run_python call. */
export function cellResultContent(outcome: CellOutcome): string {
  const sections: string[] = [];
  if (outcome.stdout) sections.push(outcome.stdout.replace(/\n$/, ""));
  if (outcome.stderr) sections.push(`[stderr]\n${outcome.stderr.replace(/\n$/, "")}`);
  for (const display of outcome.displays) sections.push(`[display]\n${display}`);
  if (outcome.result !== null) sections.push(`[result]\n${outcome.result}`);
  if (outcome.error) {
    const trace = outcome.error.traceback.join("").trim();
    sections.push(`[error]\n${trace || `${outcome.error.ename}: ${outcome.error.evalue}`}`);
  }
  const notes: string[] = [];
  if (outcome.timedOut) notes.push("the cell hit its time limit and was interrupted");
  if (outcome.aborted) notes.push("the cell was stopped because the turn was cancelled");
  if (outcome.kernelLost) notes.push("the Python kernel was restarted; variables defined since the last completed cell are lost");
  if (outcome.truncated) notes.push("output was cut in the middle; print less");
  if (notes.length) sections.push(`[note] ${notes.join("; ")}.`);
  return sections.join("\n\n") || "(no output)";
}
