import { beforeEach, describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => ({ backgroundAgentStatuses: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);

import { withBackgroundAgentStatus } from "../chat.agentStatus";

const card = {
    type: "subagent",
    call_id: "call-1",
    child_id: "42",
    address: "turn/a1/research-1",
    agent_type: "research",
    model: "opencode-go/test-model",
    task: "Find when the lease ends",
    status: "running",
    background: true,
    name: "research-1",
};
const messages = [
    { id: "u1", role: "user", content: "Research the lease" },
    {
        id: "a1",
        role: "assistant",
        content: [
            { type: "content", text: "Started research-1." },
            card,
            { ...card, child_id: "7", background: undefined, name: undefined, status: "done" },
        ],
    },
];

beforeEach(() => {
    vi.clearAllMocks();
});

describe("withBackgroundAgentStatus", () => {
    it("shows each background subagent as it stands now, not as the answer left it", async () => {
        llm.backgroundAgentStatuses.mockResolvedValue({
            "42": { status: "done", usage: { input: 900, output: 100, cost: 0.01 }, report: `The lease ends in 2031. ${"x".repeat(400)}` },
        });
        const shown = await withBackgroundAgentStatus("chat-1", messages);

        expect(llm.backgroundAgentStatuses).toHaveBeenCalledWith("chat-1", ["42"]);
        const events = shown[1].content as Record<string, unknown>[];
        expect(events[1]).toMatchObject({ status: "done", usage: { input: 900, output: 100, cost: 0.01 } });
        expect(events[1].report_preview).toMatch(/^The lease ends in 2031\./);
        expect((events[1].report_preview as string).length).toBe(280);
        // An ordinary subagent's card is the answer's own.
        expect(events[2]).toEqual(messages[1].content[2]);
        expect(shown[0]).toBe(messages[0]);
    });

    it("reads nothing for a transcript without background subagents", async () => {
        const plain = [messages[0], { id: "a2", role: "assistant", content: [{ type: "content", text: "Hi." }] }];
        expect(await withBackgroundAgentStatus("chat-1", plain)).toBe(plain);
        expect(llm.backgroundAgentStatuses).not.toHaveBeenCalled();
    });

    it("keeps the cards as stored when their status cannot be read", async () => {
        llm.backgroundAgentStatuses.mockRejectedValue(new Error("relation pi_durable.documents does not exist"));
        expect(await withBackgroundAgentStatus("chat-1", messages)).toBe(messages);
    });
});
