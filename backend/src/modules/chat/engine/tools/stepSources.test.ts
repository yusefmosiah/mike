import { describe, expect, it } from "vitest";
import * as schemas from "./toolSchemas";
import { COURTLISTENER_TOOLS } from "./courtlistenerTools";
import { WORD_CLIENT_TOOLS } from "./wordClientTools";
import { READ_MEMORY_TOOL } from "../../../../lib/memory/editTool";
import { WORKSPACE_TOOLS } from "../../../../lib/integrations/googleWorkspaceApi";
import { DRIVE_WRITE_TOOLS } from "../../../../lib/integrations/googleDriveWrites";
import { RUN_PYTHON_SCHEMA } from "../../../../lib/codemode/python";
import { delegateToolSchema } from "../subagents/subagentHost";
import { sourceMarks, stampCallIds, toolSourceAccounting, TOOL_SOURCES, withCallId } from "./stepSources";

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((tool) => (tool as { function?: { name?: string } })?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

const ADVERTISED = new Set<string>([
  ...Object.values(schemas).flatMap(names),
  ...names(COURTLISTENER_TOOLS),
  ...names(WORD_CLIENT_TOOLS),
  ...names(WORKSPACE_TOOLS),
  ...names(DRIVE_WRITE_TOOLS),
  ...names([READ_MEMORY_TOOL, RUN_PYTHON_SCHEMA, delegateToolSchema(), delegateToolSchema(true)]),
]);

describe("step source accounting", () => {
  it("covers every tool the model can be offered", () => {
    expect(ADVERTISED.size).toBeGreaterThan(30);
    const missing = [...ADVERTISED].filter((name) => toolSourceAccounting(name) === null);
    // Add each to TOOL_SOURCES in stepSources.ts, saying what it touches.
    expect(missing).toEqual([]);
  });

  it("names no tool that no longer exists", () => {
    const stale = Object.keys(TOOL_SOURCES).filter((name) => !ADVERTISED.has(name));
    expect(stale).toEqual([]);
  });
});

describe("withCallId", () => {
  it("adds the call to an event frame", () => {
    const frame = `data: ${JSON.stringify({ type: "doc_read", filename: "a.docx" })}\n\n`;
    expect(JSON.parse(withCallId(frame, "c1.2").slice(6))).toEqual({ type: "doc_read", filename: "a.docx", call_id: "c1.2" });
  });

  it("keeps a call id the event already has", () => {
    const frame = `data: ${JSON.stringify({ type: "code_cell", call_id: "c1" })}\n\n`;
    expect(withCallId(frame, "c9")).toBe(frame);
  });

  it("leaves comments, [DONE] and broken frames alone", () => {
    for (const frame of [": citation-check 1/2\n\n", "data: [DONE]\n\n", "data: {oops\n\n", "data: [1]\n\n"]) {
      expect(withCallId(frame, "c1")).toBe(frame);
    }
  });
});

describe("stampCallIds", () => {
  it("names the call on entries added since the marks, and only those", () => {
    const reads: Record<string, unknown>[] = [{ filename: "old" }];
    const finds: Record<string, unknown>[] = [];
    const lists = [reads, finds];
    const marks = sourceMarks(lists);
    reads.push({ filename: "new" });
    finds.push({ filename: "f", call_id: "kept" });
    stampCallIds(lists, marks, "c3");
    expect(reads).toEqual([{ filename: "old" }, { filename: "new", call_id: "c3" }]);
    expect(finds).toEqual([{ filename: "f", call_id: "kept" }]);
  });
});
