import { describe, expect, it } from "vitest";

import { redactArgs } from "../classifier";
import {
    AUTO_MODE_SAFE_DEFAULTS,
    DEFAULT_CLASSIFIER_MODEL,
    DOCUMENT_WRITE_TOOLS,
    TIER_1_READ_TOOLS,
    classifyToolCall,
    inScopeForContainer,
    tierForTool,
} from "../index";
import type { ClassifierCompleteFn, ClassifyToolCallInput } from "../index";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type CompleteParams = Parameters<ClassifierCompleteFn>[0];

type Payload = {
    intent: string;
    tool: string;
    args: Record<string, unknown>;
    priorTools: string[];
};

const T1_NAMES = [
    "read_document",
    "fetch_documents",
    "find_in_document",
    "list_documents",
    "read_table_cells",
    "get_diff",
    "list_workflows",
    "read_workflow",
    "courtlistener_search_case_law",
    "courtlistener_get_cases",
    "courtlistener_find_in_case",
    "courtlistener_read_case",
    "courtlistener_verify_citations",
];

const T2_NAMES = [
    "edit_document",
    "replicate_document",
    "generate_docx",
    "generate_excel",
    "generate_ppt",
];

const T3_NAMES = [
    "web_search",
    "fetch_web_page",
    "execute_code",
    "mcp__github__create_issue",
    "mcp__google_drive__upload_file",
    "google_workspace_send_email",
    "google_workspace_create_doc",
    "google_drive_move_file",
    "ask_inputs",
    "totally_unknown_tool",
    "",
];

const ALLOW_RESPONSE = '{"verdict":"allow","reason":"matches the user request"}';

function recordingComplete(respond: (params: CompleteParams) => Promise<string>) {
    const calls: CompleteParams[] = [];
    const fn: ClassifierCompleteFn = async (params) => {
        calls.push(params);
        return respond(params);
    };
    return { fn, calls };
}

function soleCall(calls: CompleteParams[]): CompleteParams {
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected exactly one classifier completion");
    return call;
}

function payloadOf(call: CompleteParams): Payload {
    return JSON.parse(call.user) as Payload;
}

function tier3Input(
    overrides: Partial<ClassifyToolCallInput> = {},
): ClassifyToolCallInput {
    return {
        userIntent: "Send the signed NDA to the client",
        toolName: "google_workspace_send_email",
        toolArgs: { to: "client@example.com" },
        history: ["read_document"],
        ...overrides,
    };
}

/** `{child:{child:...}}` of the requested object depth, `"leaf"` inside. */
function nest(depth: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = { child: value };
    return value;
}

// ---------------------------------------------------------------------------
// tier table
// ---------------------------------------------------------------------------

describe("tierForTool", () => {
    it("tiers pure reads as 1", () => {
        for (const name of T1_NAMES) expect(tierForTool(name)).toBe(1);
        expect([...TIER_1_READ_TOOLS].sort()).toEqual([...T1_NAMES].sort());
    });

    it("tiers document writes as 2", () => {
        for (const name of T2_NAMES) expect(tierForTool(name)).toBe(2);
        expect([...DOCUMENT_WRITE_TOOLS].sort()).toEqual([...T2_NAMES].sort());
    });

    it("tiers connector, mcp, ask_inputs and unknown names as 3", () => {
        for (const name of T3_NAMES) expect(tierForTool(name)).toBe(3);
    });

    it("fails closed on missing names", () => {
        expect(tierForTool(null)).toBe(3);
        expect(tierForTool(undefined)).toBe(3);
    });

    it("keeps the tier-1 and tier-2 sets disjoint", () => {
        for (const name of DOCUMENT_WRITE_TOOLS) {
            expect(TIER_1_READ_TOOLS.has(name)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// deterministic fast paths (no model call)
// ---------------------------------------------------------------------------

describe("classifyToolCall fast paths", () => {
    it("allows reads without any model call", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);

        const result = await classifyToolCall(
            tier3Input({ toolName: "read_document", completeFn: fn }),
        );

        expect(result).toEqual({
            verdict: "allow",
            reason: "read-only tool",
            tier: 1,
        });
        expect(calls).toHaveLength(0);
    });

    it("allows workspace-scoped document writes with the scope assumed", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);

        const result = await classifyToolCall(
            tier3Input({
                toolName: "edit_document",
                toolArgs: { doc_id: "doc-1" },
                completeFn: fn,
            }),
        );

        expect(result).toEqual({
            verdict: "allow",
            reason: "workspace-scoped document write",
            tier: 2,
            scopeAssumed: true,
        });
        expect(calls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// tier 3 classifier
// ---------------------------------------------------------------------------

describe("classifyToolCall tier 3", () => {
    it("allows when the classifier allows, on the default model", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result).toEqual({
            verdict: "allow",
            reason: "matches the user request",
            tier: 3,
        });
        const call = soleCall(calls);
        expect(call.model).toBe(DEFAULT_CLASSIFIER_MODEL);
        expect(call.systemPrompt).toContain("JSON only");
        expect(payloadOf(call)).toEqual({
            intent: "Send the signed NDA to the client",
            tool: "google_workspace_send_email",
            args: { to: "client@example.com" },
            priorTools: ["read_document"],
        });
    });

    it("passes the caller's model and api keys through", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);

        await classifyToolCall(
            tier3Input({
                completeFn: fn,
                model: "opencode-go/kimi-k3",
                apiKeys: { "opencode-go": "sk-user-key" },
            }),
        );

        const call = soleCall(calls);
        expect(call.model).toBe("opencode-go/kimi-k3");
        expect(call.apiKeys).toEqual({ "opencode-go": "sk-user-key" });
    });

    it("denies with the classifier's reason when it denies", async () => {
        const { fn } = recordingComplete(async () =>
            '{"verdict":"deny","reason":"sends document text to an external service"}',
        );

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result).toEqual({
            verdict: "deny",
            reason: "sends document text to an external service",
            tier: 3,
        });
    });

    it("accepts a fenced JSON verdict", async () => {
        const { fn } = recordingComplete(async () =>
            '```json\n{"verdict":"allow","reason":"plain read"}\n```',
        );

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result.verdict).toBe("allow");
        expect(result.reason).toBe("plain read");
    });

    it("denies an unparseable verdict", async () => {
        const { fn } = recordingComplete(async () => "I think this call is fine.");

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result.verdict).toBe("deny");
        expect(result.reason).toContain("unverifiable");
    });

    it("denies an out-of-vocabulary verdict", async () => {
        const { fn } = recordingComplete(async () =>
            '{"verdict":"maybe","reason":"unsure"}',
        );

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result.verdict).toBe("deny");
        expect(result.reason).toContain("unverifiable");
    });

    it("denies when the completion throws", async () => {
        const { fn } = recordingComplete(() =>
            Promise.reject(new Error("provider exploded")),
        );

        const result = await classifyToolCall(tier3Input({ completeFn: fn }));

        expect(result).toEqual({
            verdict: "deny",
            reason: "classifier unavailable",
            tier: 3,
        });
    });

    it("denies when the completion times out", async () => {
        const { fn } = recordingComplete(() => new Promise<string>(() => {}));

        const result = await classifyToolCall(
            tier3Input({ completeFn: fn, timeoutMs: 25 }),
        );

        expect(result.verdict).toBe("deny");
        expect(result.reason).toContain("classifier unavailable");
        expect(result.reason).toContain("timed out");
    });

    it("truncates the intent and keeps only the last ten prior tools", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);
        const history = Array.from({ length: 12 }, (_, index) => `tool_${index + 1}`);

        await classifyToolCall(
            tier3Input({
                completeFn: fn,
                userIntent: "a".repeat(2500),
                history,
            }),
        );

        const payload = payloadOf(soleCall(calls));
        expect(payload.intent).toHaveLength(2000);
        expect(payload.priorTools).toEqual(history.slice(-10));
    });

    it("never forwards anything outside the classifier payload (no assistant prose)", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);
        const input = {
            ...tier3Input(),
            assistantProse: "CONFIDENTIAL ASSISTANT PROSE",
            priorAssistantMessage: "another prose the assistant wrote",
        } as ClassifyToolCallInput;

        await classifyToolCall({ ...input, completeFn: fn });

        const call = soleCall(calls);
        expect(JSON.stringify(call)).not.toContain("CONFIDENTIAL ASSISTANT PROSE");
        expect(JSON.stringify(call)).not.toContain("another prose");
        expect(Object.keys(payloadOf(call)).sort()).toEqual([
            "args",
            "intent",
            "priorTools",
            "tool",
        ]);
    });

    it("redacts secrets and truncates long argument strings before the model sees them", async () => {
        const { fn, calls } = recordingComplete(async () => ALLOW_RESPONSE);
        const body = "x".repeat(900);

        await classifyToolCall(
            tier3Input({
                completeFn: fn,
                toolArgs: {
                    document_id: "doc-1",
                    apiKey: "sk-live-abcdef",
                    nested: { access_token: "tok_123", password: "hunter2" },
                    body,
                },
            }),
        );

        const call = soleCall(calls);
        const args = payloadOf(call).args as {
            document_id: string;
            apiKey: string;
            nested: { access_token: string; password: string };
            body: string;
        };
        expect(args.document_id).toBe("doc-1");
        expect(args.apiKey).toBe("[redacted]");
        expect(args.nested).toEqual({
            access_token: "[redacted]",
            password: "[redacted]",
        });
        expect(args.body).toHaveLength(500 + "…[truncated]".length);
        expect(args.body.endsWith("…[truncated]")).toBe(true);
        expect(call.user).not.toContain("x".repeat(600));
        expect(call.user).not.toContain("sk-live-abcdef");
        expect(call.user).not.toContain("hunter2");
    });
});

// ---------------------------------------------------------------------------
// redaction unit surface
// ---------------------------------------------------------------------------

describe("redactArgs", () => {
    it("keeps short strings and non-object values as they are", () => {
        expect(redactArgs("short")).toBe("short");
        expect(redactArgs(42)).toBe(42);
        expect(redactArgs(null)).toBeNull();
        expect(redactArgs(["a", true])).toEqual(["a", true]);
    });

    it("truncates a long string to the limit plus a marker", () => {
        const truncated = redactArgs("y".repeat(501)) as string;
        expect(truncated).toBe(`${"y".repeat(500)}…[truncated]`);
    });

    it("redacts secret-looking keys, even false positives", () => {
        expect(
            redactArgs({ apiKey: "a", keywords: "b", monkey: "c", plain: "d" }),
        ).toEqual({
            apiKey: "[redacted]",
            keywords: "[redacted]",
            monkey: "[redacted]",
            plain: "d",
        });
    });

    it("stops at the depth limit", () => {
        expect(redactArgs(nest(2))).toEqual({ child: { child: "leaf" } });
        expect(JSON.stringify(redactArgs(nest(8)))).toContain("[max-depth]");
    });
});

// ---------------------------------------------------------------------------
// container scope
// ---------------------------------------------------------------------------

describe("inScopeForContainer", () => {
    it("allows ordinary write arguments with no container target", () => {
        expect(
            inScopeForContainer({ doc_id: "doc-1", content: "hi" }, "project-1"),
        ).toBe(true);
        expect(
            inScopeForContainer({ doc_id: "doc-1", content: "hi" }, undefined),
        ).toBe(true);
    });

    it("allows targets that are the turn's own container", () => {
        expect(inScopeForContainer({ project_id: "project-1" }, "project-1")).toBe(
            true,
        );
        expect(
            inScopeForContainer({ target_project_id: "project-1" }, "project-1"),
        ).toBe(true);
        expect(
            inScopeForContainer({ projectId: "project-1" }, "project-1"),
        ).toBe(true);
        expect(
            inScopeForContainer({ library_folder_id: "folder-9" }, "folder-9"),
        ).toBe(true);
    });

    it("denies targets that point at another container", () => {
        expect(inScopeForContainer({ project_id: "project-2" }, "project-1")).toBe(
            false,
        );
        expect(
            inScopeForContainer({ target_project_id: "project-2" }, "project-1"),
        ).toBe(false);
        expect(
            inScopeForContainer({ library_folder_id: "folder-9" }, "project-1"),
        ).toBe(false);
        expect(inScopeForContainer({ projectId: "project-2" }, "project-1")).toBe(
            false,
        );
    });

    it("denies any target when the turn has no container", () => {
        expect(inScopeForContainer({ project_id: "project-1" }, undefined)).toBe(
            false,
        );
        expect(inScopeForContainer({ project_id: "project-1" }, null)).toBe(false);
        expect(inScopeForContainer({ project_id: "project-1" }, "   ")).toBe(false);
    });

    it("denies container-ish keys it cannot place", () => {
        expect(
            inScopeForContainer({ target_folder_id: "folder-9" }, "project-1"),
        ).toBe(false);
        expect(
            inScopeForContainer({ drive_folder_id: "drive-9" }, "project-1"),
        ).toBe(false);
        expect(inScopeForContainer({ project_id: {} }, "project-1")).toBe(false);
    });

    it("denies a mismatched target nested in the arguments", () => {
        expect(
            inScopeForContainer(
                { edits: [{ project_id: "project-1" }, { project_id: "project-2" }] },
                "project-1",
            ),
        ).toBe(false);
    });

    it("ignores null and empty targets", () => {
        expect(
            inScopeForContainer(
                { project_id: null, target_project_id: "", library_folder_id: undefined },
                "project-1",
            ),
        ).toBe(true);
    });

    it("matches numeric targets by value", () => {
        expect(inScopeForContainer({ project_id: 7 }, "7")).toBe(true);
        expect(inScopeForContainer({ project_id: 7 }, "8")).toBe(false);
    });

    it("fails closed past the inspectable depth", () => {
        expect(inScopeForContainer(nest(6) as Record<string, unknown>, "project-1")).toBe(
            true,
        );
        expect(inScopeForContainer(nest(7) as Record<string, unknown>, "project-1")).toBe(
            false,
        );
    });
});

// ---------------------------------------------------------------------------
// auto mode defaults + index surface
// ---------------------------------------------------------------------------

describe("AUTO_MODE_SAFE_DEFAULTS", () => {
    it("selects first options, empty text, skips uploads and never auto-approves", () => {
        expect(AUTO_MODE_SAFE_DEFAULTS.choice).toBe("first_option");
        expect(AUTO_MODE_SAFE_DEFAULTS.multi_choice).toBe("first_option");
        expect(AUTO_MODE_SAFE_DEFAULTS.text).toBe("");
        expect(AUTO_MODE_SAFE_DEFAULTS.documents).toBe("skip");
        expect(AUTO_MODE_SAFE_DEFAULTS.approval).toBe("deny");
    });
});

describe("guardrails index", () => {
    it("exposes the tiering, scope and classifier helpers", () => {
        expect(typeof classifyToolCall).toBe("function");
        expect(typeof tierForTool).toBe("function");
        expect(typeof inScopeForContainer).toBe("function");
        expect(TIER_1_READ_TOOLS.has("read_document")).toBe(true);
        expect(DOCUMENT_WRITE_TOOLS.has("edit_document")).toBe(true);
        expect(DEFAULT_CLASSIFIER_MODEL).toBe("opencode-go/glm-5.3-flash");
    });
});
