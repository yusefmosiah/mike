import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantEvent, SubagentEvent } from "@mike/contracts";
import type { Db } from "../../../../lib/db";
import { DELEGATE_TOOL_SUMMARY, type SubagentSpec } from "../../../../lib/llm/types";
import { isParallelSafeTool } from "../../../../lib/guardrails";

const routerModels = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../../lib/routerModels", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../lib/routerModels")>()),
    getAllUserRouterModels: routerModels.get,
}));
const endpoints = vi.hoisted(() => ({ list: vi.fn(() => [] as unknown[]) }));
vi.mock("../../../../lib/llm/registry", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../lib/llm/registry")>()),
    configuredEndpointSummaries: endpoints.list,
}));

import { createSubagentHost, type SubagentHostArgs } from "../subagents/subagentHost";
import {
    delegableModels,
    delegableModelsTable,
    resetSubagentPriceCacheForTests,
    speedTier,
} from "../subagents/subagentModels";
import {
    loadSubagentTypes,
    parseFrontmatter,
    parseSubagentType,
    subagentModelMemo,
    type SubagentType,
} from "../subagents/subagentTypes";

const db = {} as Db;

function typeSource(fields: Record<string, string>, body = "Review the documents.") {
    const lines = Object.entries({
        name: "document_review",
        description: "Reviews documents.",
        tools: "read_document, find_in_document",
        max_rounds: "8",
        max_output_tokens: "24000",
        timeout_ms: "300000",
        ...fields,
    })
        .filter(([, value]) => value !== "")
        .map(([key, value]) => `${key}: ${value}`);
    return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

describe("subagent types", () => {
    it("parses frontmatter and the instructions body", () => {
        expect(parseFrontmatter("---\na: 1\n# note\nb: two: three\n---\nBody\n")).toEqual({
            fields: { a: "1", b: "two: three" },
            body: "Body",
        });
        expect(() => parseFrontmatter("no frontmatter")).toThrow("missing frontmatter");
    });

    it("reads a valid type", () => {
        expect(parseSubagentType(typeSource({}), "document_review.md")).toEqual({
            name: "document_review",
            description: "Reviews documents.",
            tools: ["read_document", "find_in_document"],
            maxRounds: 8,
            maxOutputTokens: 24000,
            timeoutMs: 300000,
            instructions: "Review the documents.",
        });
    });

    it("reads tools: * as every tool the parent has", () => {
        expect(parseSubagentType(typeSource({ tools: "*" }), "document_review.md").tools).toBe("all");
    });

    it.each([
        [{ tools: "read_document, delegate" }, "tool delegate is never given to a subagent"],
        [{ tools: "ask_inputs" }, "tool ask_inputs is never given to a subagent"],
        [{ tools: "*, read_document" }, "tools: * stands alone"],
        [{ tools: "" }, "tools must be * or list at least one tool"],
        [{ name: "Document-Review" }, "name must be snake_case"],
        [{ name: "other_review" }, "name must match the file name"],
        [{ description: "" }, "description is required"],
        [{ max_rounds: "0" }, "max_rounds must be a positive integer"],
        [{ timeout_ms: "soon" }, "timeout_ms must be a positive integer"],
    ])("refuses %o", (fields, message) => {
        expect(() => parseSubagentType(typeSource(fields), "document_review.md")).toThrow(message);
    });

    it("refuses an empty body", () => {
        expect(() => parseSubagentType(typeSource({}, ""), "document_review.md")).toThrow("body is empty");
    });

    it("loads every shipped type, and names a malformed file", () => {
        const shipped = loadSubagentTypes();
        expect([...shipped.keys()]).toEqual(["citation_check", "general"]);
        expect(shipped.get("general")?.tools).toBe("all");
        // The checker only looks things up.
        const checker = shipped.get("citation_check")!.tools as string[];
        expect(checker).toContain("web_search");
        expect(checker).toContain("courtlistener_verify_citations");
        expect(checker.every((tool) => isParallelSafeTool(tool))).toBe(true);
        expect(subagentModelMemo()).toContain("Leave `model` out");

        const dir = mkdtempSync(path.join(tmpdir(), "subagent-types-"));
        writeFileSync(path.join(dir, "broken.md"), typeSource({ name: "broken", tools: "delegate" }));
        expect(() => loadSubagentTypes(dir)).toThrow("Subagent type broken.md: tool delegate is never given to a subagent");
    });
});

describe("subagent models", () => {
    beforeEach(() => {
        routerModels.get.mockResolvedValue({ openrouter: [], vercel: [], "opencode-go": [] });
        endpoints.list.mockReturnValue([]);
        resetSubagentPriceCacheForTests();
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        ["gemini-3-flash", "fast"],
        ["claude-haiku-4-5", "fast"],
        ["openrouter/liquid/lfm-3b", "fast"],
        ["gpt-5-mini", "fast"],
        ["gemini-3-flash-lite", "fast"],
        ["claude-opus-4-6", "deep"],
        ["gemini-3-pro-preview", "deep"],
        ["claude-sonnet-4-6", "standard"],
        ["opencode-go/deepseek-v4.1", "standard"],
    ])("puts %s in the %s tier", (model, tier) => {
        expect(speedTier(model)).toBe(tier);
    });

    it("lists the chat model first, then routers with a key, priced from the catalog", async () => {
        routerModels.get.mockResolvedValue({
            openrouter: ["liquid/lfm-3b"],
            vercel: ["ignored/no-key"],
            "opencode-go": ["deepseek-v4.1-flash"],
        });
        const fetchImpl = vi.fn(async () =>
            Response.json({
                data: [
                    { id: "liquid/lfm-3b", pricing: { prompt: "0.00000002", completion: "0.0000001" } },
                    { id: "broken", pricing: { prompt: "n/a" } },
                ],
            }),
        );
        const models = await delegableModels({
            db,
            userId: "u1",
            apiKeys: { openrouter: "k", "opencode-go": "k" } as never,
            chatModel: "opencode-go/deepseek-v4.1-flash",
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(models).toEqual([
            { id: "opencode-go/deepseek-v4.1-flash", speed: "fast", price: "flat subscription" },
            { id: "openrouter/liquid/lfm-3b", speed: "fast", price: "$0.02 / $0.10" },
        ]);

        // The catalog is cached: a second lookup does not fetch again.
        await delegableModels({ db, userId: "u1", chatModel: "opencode-go/x", fetchImpl: fetchImpl as unknown as typeof fetch });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("keeps the list when the catalog is unreachable", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error("offline");
        });
        const models = await delegableModels({
            db,
            userId: "u1",
            apiKeys: { openrouter: "k" } as never,
            chatModel: "openrouter/liquid/lfm-3b",
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(models).toEqual([{ id: "openrouter/liquid/lfm-3b", speed: "fast", price: "unknown" }]);
    });

    it("in strict private mode, fetches no prices and offers only private models", async () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        routerModels.get.mockResolvedValue({ openrouter: ["liquid/lfm-3b"], vercel: [], "opencode-go": ["glm-5"] });
        const fetchImpl = vi.fn();
        const models = await delegableModels({
            db,
            userId: "u1",
            apiKeys: { openrouter: "k", "opencode-go": "k" } as never,
            chatModel: "opencode-go/glm-5",
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(models.map((model) => model.id)).toEqual(["opencode-go/glm-5"]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("renders a table that marks the conversation's model", () => {
        const table = delegableModelsTable(
            [
                { id: "a", speed: "standard", price: "unknown" },
                { id: "b", speed: "fast", price: "$0.10 / $0.40" },
            ],
            "a",
        );
        expect(table.split("\n")).toEqual([
            "| model | speed | price per 1M tokens, input / output |",
            "| --- | --- | --- |",
            "| a (this conversation's model) | standard | unknown |",
            "| b | fast | $0.10 / $0.40 |",
        ]);
    });
});

describe("subagent host", () => {
    const reviewType: SubagentType = {
        name: "document_review",
        description: "Reviews documents.",
        tools: ["read_document", "find_in_document"],
        maxRounds: 8,
        maxOutputTokens: 24000,
        timeoutMs: 300000,
        instructions: "You are a reviewer.",
    };
    const tableType: SubagentType = { ...reviewType, name: "table_check", tools: ["read_table_cells"] };
    const generalType: SubagentType = { ...reviewType, name: "general", tools: "all" };
    const runTools = vi.fn(async (calls: { id: string }[]) =>
        calls.map((call) => ({ tool_use_id: call.id, content: "Clause 12" })),
    );

    function args(overrides: Partial<SubagentHostArgs> = {}) {
        const writes: string[] = [];
        const events: AssistantEvent[] = [];
        const hostArgs: SubagentHostArgs = {
            db,
            userId: "u1",
            chatModel: "chat-model",
            reasoning: "high" as never,
            runTools,
            docIndex: {
                "doc-0": { document_id: "11111111-aaaa", filename: "NDA.docx" },
                "doc-1": { document_id: "22222222-bbbb", filename: "MSA.pdf" },
            },
            offeredTools: ["read_document", "list_documents", "edit_document", "web_search", "delegate", "ask_inputs"],
            write: (chunk) => writes.push(chunk),
            events,
            types: new Map([
                [reviewType.name, reviewType],
                [tableType.name, tableType],
            ]),
            models: [
                { id: "chat-model", speed: "standard", price: "unknown" },
                { id: "fast-model", speed: "fast", price: "$0.10 / $0.40" },
            ],
            ...overrides,
        };
        return { hostArgs, writes, events };
    }

    it("offers only types whose tools the parent has, with the models table", async () => {
        const { hostArgs } = args();
        const { host, promptSection } = await createSubagentHost(hostArgs);
        expect(promptSection).toContain("- document_review: Reviews documents.");
        expect(promptSection).not.toContain("table_check");
        expect(promptSection).toContain("omit `model` to use chat-model");
        expect(promptSection).toContain("| fast-model | fast | $0.10 / $0.40 |");
        expect(host.toolDescription.startsWith(DELEGATE_TOOL_SUMMARY)).toBe(true);
        expect(host.toolDescription).toContain("How to choose a subagent's model");
    });

    it.each([
        [{ type: "table_check", task: "x" }, 'Unknown subagent type "table_check". Types available here: document_review.'],
        [{ task: "x" }, "Unknown subagent type. Types available here: document_review."],
        [{ type: "document_review", task: "  " }, "Give the subagent a task"],
        [{ type: "document_review", task: "x".repeat(8001) }, "The task is too long (8001 characters"],
        [{ type: "document_review", task: "x", model: "claude-opus-4-6" }, 'Model "claude-opus-4-6" is not available to this user. Models you may use: chat-model, fast-model.'],
        [{ type: "document_review", task: "x", documents: "doc-0" }, "documents must be a list"],
        [{ type: "document_review", task: "x", documents: ["doc-9"] }, 'Unknown document "doc-9". Documents here: doc-0, doc-1.'],
    ])("refuses %o with a message the model can act on", async (input, message) => {
        const { host } = await createSubagentHost(args().hostArgs);
        const refusal = await host.prepare(input);
        expect(typeof refusal).toBe("string");
        expect(refusal).toContain(message);
    });

    it("builds a spec on the type's budgets and the tools both sides allow", async () => {
        const { host } = await createSubagentHost(args().hostArgs);
        const spec = (await host.prepare({
            type: "document_review",
            task: "Find the governing law",
            documents: ["doc-1", "11111111-aaaa"],
        })) as SubagentSpec;
        expect(spec).toMatchObject({
            type: "document_review",
            model: "chat-model",
            reasoning: "high",
            tools: ["read_document"],
            maxRounds: 8,
            maxOutputTokens: 24000,
            timeoutMs: 300000,
        });
        expect(spec.instructions).toMatch(/^You are a reviewer\.\n\nRULES:/);
        expect(spec.task).toBe(
            "Find the governing law\n\nDocuments named for this task:\n- doc-1: MSA.pdf\n- doc-0: NDA.docx",
        );

        const other = (await host.prepare({ type: "document_review", task: "x", model: "fast-model" })) as SubagentSpec;
        expect(other.model).toBe("fast-model");
        // The conversation's reasoning level belongs to its model.
        expect(other.reasoning).toBeUndefined();
    });

    it("gives a general child every tool the parent has, except delegate and ask_inputs", async () => {
        const { host, promptSection } = await createSubagentHost(
            args({ types: new Map([[generalType.name, generalType]]) }).hostArgs,
        );
        expect(promptSection).toContain("- general:");
        const spec = (await host.prepare({ type: "general", task: "x" })) as SubagentSpec;
        expect(spec.tools).toEqual(["read_document", "list_documents", "edit_document", "web_search"]);
    });

    it("runs only the child's own tools through the turn's runner, and answers the rest as unavailable", async () => {
        runTools.mockClear();
        const { host } = await createSubagentHost(args().hostArgs);
        const spec = (await host.prepare({ type: "document_review", task: "x" })) as SubagentSpec;
        const results = await spec.runTools([
            { id: "c1", name: "read_document", input: { doc_id: "doc-0" } },
            { id: "c2", name: "edit_document", input: {} },
        ]);
        expect(runTools).toHaveBeenCalledTimes(1);
        expect(runTools).toHaveBeenCalledWith([{ id: "c1", name: "read_document", input: { doc_id: "doc-0" } }]);
        expect(results).toEqual([
            { tool_use_id: "c1", content: "Clause 12" },
            { tool_use_id: "c2", content: JSON.stringify({ error: "Tool 'edit_document' is not available to this subagent." }) },
        ]);
    });

    it("records a child's start and finish as one event, streamed both times", async () => {
        const { hostArgs, writes, events } = args();
        const { host } = await createSubagentHost(hostArgs);
        const child = {
            callId: "call-1",
            childId: "7",
            address: "turn/a1/document_review-1",
            type: "document_review",
            model: "chat-model",
            task: "Find the governing law",
        };
        host.started!(child);
        host.finished!({
            callId: "call-1",
            childId: "7",
            status: "done",
            report: "Governed by Delaware law. ".repeat(20),
            usage: { input: 100, output: 50, cost: 0.001 },
        });

        expect(events).toHaveLength(1);
        const event = events[0] as SubagentEvent;
        expect(event).toMatchObject({
            type: "subagent",
            call_id: "call-1",
            child_id: "7",
            address: "turn/a1/document_review-1",
            agent_type: "document_review",
            status: "done",
            usage: { input: 100, output: 50, cost: 0.001 },
        });
        expect(event.report_preview).toHaveLength(280);
        const frames = writes.map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
        expect(frames.map((frame) => frame.status)).toEqual(["running", "done"]);

        // A restarted turn starts the same child again: still one event.
        host.started!(child);
        expect(events).toHaveLength(1);
        expect((events[0] as SubagentEvent).status).toBe("running");
    });
});
