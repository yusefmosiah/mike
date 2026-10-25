import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "@/app/components/shared/types";
import { mergedReasoningSummary, nestCellSources, sourceSummary } from "./stepSources";

const cell = (call_id: string): AssistantEvent => ({ type: "code_cell", call_id, code: "x", status: "ok" });

describe("nestCellSources", () => {
    it("puts each call's events under the cell that made it", () => {
        const events: AssistantEvent[] = [
            { type: "reasoning", text: "Plan" },
            cell("c1"),
            { type: "doc_read", filename: "lease.docx", call_id: "c1.docs" },
            { type: "web_search", query: "break clause", results: [], call_id: "c1.1" },
            cell("c2"),
            { type: "web_fetch", url: "https://a.example/", call_id: "c2.1" },
            { type: "doc_read", filename: "direct.docx", call_id: "other" },
        ];
        const steps = nestCellSources(events, events.map((_, i) => i + 10));
        expect(steps.map((step) => step.event.type)).toEqual(["reasoning", "code_cell", "code_cell", "doc_read"]);
        expect(steps[1].sources.map((source) => source.index)).toEqual([12, 13]);
        expect(steps[2].sources.map((source) => source.event.type)).toEqual(["web_fetch"]);
        expect(steps[3].index).toBe(16);
    });

    it("keeps an event whose cell is not in the group as its own step", () => {
        const steps = nestCellSources([{ type: "doc_read", filename: "a", call_id: "gone.1" }], [0]);
        expect(steps).toHaveLength(1);
    });
});

describe("sourceSummary", () => {
    it("counts distinct sources per kind", () => {
        const events: AssistantEvent[] = [
            { type: "doc_read", filename: "a.docx", document_id: "d1" },
            { type: "doc_find", filename: "a.docx", document_id: "d1", query: "cap", total_matches: 2 },
            { type: "doc_read", filename: "b.docx", document_id: "d2" },
            { type: "web_fetch", url: "https://a.example/" },
            { type: "web_fetch", url: "https://down.example/", error: true },
            { type: "web_search", query: "cap", results: [] },
        ];
        expect(sourceSummary(events)).toBe("2 documents, 1 web page, 1 web search");
    });

    it("counts cases by cluster and connector calls that finished", () => {
        const events: AssistantEvent[] = [
            { type: "courtlistener_read_case", cluster_id: 7, opinion_count: 1 },
            { type: "courtlistener_read_case", cluster_id: null, opinion_count: 0 },
            {
                type: "courtlistener_get_cases",
                cluster_ids: [7, 8],
                cases: [
                    { cluster_id: 7, case_name: "A v B", citation: null },
                    { cluster_id: 8, case_name: "C v D", citation: null },
                ],
            },
            { type: "courtlistener_get_cases", cluster_ids: [] },
            {
                type: "mcp_tool_call",
                connector_id: "c",
                connector_name: "Drive",
                tool_name: "search",
                openai_tool_name: "drive_search",
                status: "ok",
                call_id: "c1.1",
            },
            {
                type: "mcp_tool_call",
                connector_id: "c",
                connector_name: "Drive",
                tool_name: "read",
                openai_tool_name: "drive_read",
                status: "ok",
            },
            {
                type: "mcp_tool_call",
                connector_id: "c",
                connector_name: "Drive",
                tool_name: "read",
                openai_tool_name: "drive_read",
                status: "ok",
                isStreaming: true,
            },
            {
                type: "mcp_tool_call",
                connector_id: "c",
                connector_name: "Drive",
                tool_name: "read",
                openai_tool_name: "drive_read",
                status: "error",
            },
        ];
        expect(sourceSummary(events)).toBe("2 cases, 2 connector calls");
    });

    it("says nothing when nothing was read", () => {
        expect(sourceSummary([{ type: "reasoning", text: "x" }])).toBeNull();
    });
});

describe("mergedReasoningSummary", () => {
  const long = "x".repeat(300);
  const said = (text: string) => ({ text, source: "side_model" as const, model: "m" });

  it("joins both summaries, letting a short block stand for itself", () => {
    expect(
      mergedReasoningSummary(
        { type: "reasoning", text: long, summary: said("Read the lease.") },
        { type: "reasoning", text: "  Now the deed. " },
      ),
    ).toEqual(said("Read the lease.\nNow the deed."));
    expect(
      mergedReasoningSummary(
        { type: "reasoning", text: "Short." },
        { type: "reasoning", text: long, summary: said("Read the deed.") },
      ),
    ).toEqual(said("Short.\nRead the deed."));
  });

  it("has none when neither has one, or a long block has none", () => {
    expect(mergedReasoningSummary({ type: "reasoning", text: "a" }, { type: "reasoning", text: "b" })).toBeUndefined();
    expect(
      mergedReasoningSummary(
        { type: "reasoning", text: long, summary: said("Read the lease.") },
        { type: "reasoning", text: long },
      ),
    ).toBeUndefined();
  });
});
