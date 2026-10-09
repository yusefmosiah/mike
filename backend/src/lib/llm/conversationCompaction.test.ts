import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai" with { "resolution-mode": "import" };
import { compactModelMessages, replayConversationCompaction } from "./conversationCompaction";

const base = { modelId: "glm-5.3", systemPrompt: "Answer the current request." };

function history(): ModelMessage[] {
  return [
    { role: "user", content: "Review doc-0 and preserve the dates." },
    { role: "assistant", content: "Old background. ".repeat(220_000) },
    { role: "user", content: "What are the deadlines?" },
  ];
}

describe("model conversation checkpoints", () => {
  it("preserves the same array and message objects below threshold", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    expect(compactModelMessages({ ...base, messages }).messages).toBe(messages);
    expect(replayConversationCompaction({ ...base, messages }).messages).toBe(messages);
  });

  it("replays stable checkpoints when a full transcript gains another turn", () => {
    const messages = history();
    const first = replayConversationCompaction({ ...base, messages });
    expect(first.compacted).toBe(true);
    expect(first.messages[0].content).toContain("preserve the dates");
    expect(first.messages.at(-1)).toBe(messages.at(-1));
    const answer: ModelMessage = { role: "assistant", content: "The deadline is 7 October." };
    const question: ModelMessage = { role: "user", content: "And the notice period?" };
    const next = replayConversationCompaction({ ...base, messages: [...messages, answer, question] });
    expect(next.messages).toEqual([...first.messages, answer, question]);
  });

  it("keeps the active user request and complete tool pairs even when the result exceeds the tail budget", () => {
    const request: ModelMessage = { role: "user", content: "Use the exact date in doc-1." };
    const call: ModelMessage = { role: "assistant", content: [
      { type: "tool-call", toolCallId: "c1", toolName: "read_document", input: { doc_id: "doc-1" } },
    ] };
    const result: ModelMessage = { role: "tool", content: [
      { type: "tool-result", toolCallId: "c1", toolName: "read_document", output: { type: "text", value: "7 October. ".repeat(9_000) } },
    ] };
    const messages = [...history().slice(0, 2), request, call, result];
    const compacted = compactModelMessages({ ...base, messages });
    expect(compacted.compacted).toBe(true);
    expect(compacted.messages.slice(-3)).toEqual([request, call, result]);
    expect(compacted.messages.at(-2)).toBe(call);
    expect(compacted.messages.at(-1)).toBe(result);
  });

  it("never discards a pending tool call or the active request", () => {
    const pending: ModelMessage = { role: "assistant", content: [
      { type: "tool-call", toolCallId: "pending", toolName: "read_document", input: {} },
    ] };
    const messages = [pending, ...history()];
    const result = compactModelMessages({ ...base, messages });
    expect(result.compacted).toBe(true);
    expect(result.messages).toContain(pending);
    expect(result.messages).toContain(messages.at(-1));
  });

  it("requires a real reduction on forced overflow and accounts for the fixed prompt", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "A single active request." }];
    expect(compactModelMessages({ ...base, messages, force: true }).compacted).toBe(false);
    expect(compactModelMessages({ ...base, messages: history(), systemPrompt: "S".repeat(3_000_000) }).compacted).toBe(false);
  });

  it("does not send corrupted Unicode archive images", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Check § 2 — ‘notice’." },
      { role: "assistant", content: "Old background. ".repeat(220_000) },
      { role: "user", content: "Which clause applies?" },
    ];
    const result = compactModelMessages({ ...base, modelId: "glm-5.3-flash", messages });
    expect(result.compacted).toBe(true);
    expect(typeof result.messages[0].content).toBe("string");
    expect(result.messages[0].content).toContain("§ 2 — ‘notice’");
  });

  it.each([false, true])("bounds the newest completed tool output without changing its call or losing the final date (force=%s)", (force) => {
    const request: ModelMessage = { role: "user", content: "Read doc-9 and tell me its final deadline." };
    const call: ModelMessage = { role: "assistant", content: [
      { type: "tool-call", toolCallId: "c9", toolName: "read_document", input: { doc_id: "doc-9" } },
    ] };
    const output = "Earlier schedule detail. ".repeat(force ? 16_000 : 170_000) + "\nFINAL DEADLINE: 2026-10-21.";
    const tool: ModelMessage = { role: "tool", content: [
      { type: "tool-result", toolCallId: "c9", toolName: "read_document", output: { type: "text", value: output } },
    ] };
    const messages = [request, call, tool];
    const result = compactModelMessages({ ...base, messages, force });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toBe(request);
    expect(result.messages[1]).toBe(call);
    const retained = result.messages.at(-1);
    expect(retained?.role).toBe("tool");
    if (retained?.role !== "tool") throw new Error("Missing typed tool result");
    expect(retained.content[0]).toMatchObject({
      toolCallId: "c9",
      toolName: "read_document",
      output: { type: "text", value: expect.stringContaining("FINAL DEADLINE: 2026-10-21.") },
    });
    const encoded = JSON.stringify(retained.content);
    expect(encoded).toContain("full output omitted");
    expect(encoded.length).toBeLessThan(45_000);
    expect(tool).toMatchObject({ content: [{ output: { type: "text", value: output } }] });
  });

  it("counts media when deciding whether old context fits the window and retained tail", () => {
    const images: ModelMessage = { role: "user", content: Array.from({ length: 201 }, () => ({
      type: "image" as const,
      image: "https://example.invalid/synthetic.png",
    })) };
    const request: ModelMessage = { role: "user", content: "Use the earlier descriptions to list the dates." };
    const result = compactModelMessages({ ...base, messages: [images, request] });
    expect(result.compacted).toBe(true);
    expect(result.messages.at(-1)).toBe(request);
    expect(result.messages[0].content).toContain("[Attached media]");
    expect(result.messages).not.toContain(images);
  });

  it("leaves summary headroom when a completed result nearly fills the recovery band", () => {
    const active = "u".repeat(2_440_000);
    const call: ModelMessage = { role: "assistant", content: [{
      type: "tool-call", toolCallId: "c1", toolName: "read_document", input: { doc_id: "doc-0" },
    }] };
    const messages: ModelMessage[] = [
      { role: "user", content: "Earlier request about doc-0." },
      { role: "assistant", content: "Earlier observation." },
      { role: "user", content: active },
      call,
      { role: "tool", content: [{
        type: "tool-result", toolCallId: "c1", toolName: "read_document",
        output: { type: "text", value: "x".repeat(119_734) + " Final deadline: 2026-10-21." },
      }] },
    ];
    const result = compactModelMessages({
      messages, modelId: "glm-5.3", systemPrompt: "", contextTokens: 900_000,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages.some((message) => message.role === "user" && message.content === active)).toBe(true);
    expect(result.messages).toContain(call);
    expect(JSON.stringify(result.messages)).toContain("Earlier request about doc-0.");
    expect(JSON.stringify(result.messages)).toContain("Final deadline: 2026-10-21.");
    expect(JSON.stringify(result.messages).length).toBeLessThan(2_560_000);
  });
});
