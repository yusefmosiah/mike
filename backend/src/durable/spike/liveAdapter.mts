// Spike: the Pi-backed streamChatWithTools against a live OpenCode Go model.
//
//   PI_DURABLE_DATABASE_URL=postgres://.../pi_spike PI_DURABLE_SCHEMA=live_x npx tsx src/durable/spike/liveAdapter.mts
//
// Turn 1: the model must call read_document to learn a fact that never appears
// in chat text. Turn 2 (no tools offered): it must answer from the tool result
// it saw last turn. Turn 3 regenerates turn 2: the client sends the same
// history again, which must fork rather than continue.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { streamChatWithToolsOnPi, piRuntime } from "../../lib/llm/pi/runtime.mjs";
import type { LlmMessage, OpenAIToolSchema } from "../../lib/llm/types.js";

process.loadEnvFile(".env");
const model = process.env.SPIKE_MODEL ?? "opencode-go/glm-5.3";
const chatId = `spike-${randomUUID()}`;
const SECRET = `ZEPHYR-${Math.floor(Math.random() * 9000 + 1000)}`;
const readDocument: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read a document from the matter file by its id.",
    parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] },
  },
};
const system = "You are Mike, a legal assistant. Be brief.";
let toolRuns = 0;

async function turn(label: string, messages: LlmMessage[], tools: OpenAIToolSchema[]) {
  let streamed = 0;
  const calls: string[] = [];
  const t0 = performance.now();
  const result = await streamChatWithToolsOnPi({
    model,
    systemPrompt: system,
    messages,
    tools,
    reasoning: "low",
    conversationId: chatId,
    callbacks: {
      onContentDelta: (d) => (streamed += d.length),
      onToolCallStart: (c) => calls.push(`${c.name}(${JSON.stringify(c.input)})`),
    },
    runTools: async (batch) =>
      batch.map((call) => {
        toolRuns++;
        return { tool_use_id: call.id, content: `NDA-7 text: "The escrow agent's code word is ${SECRET}." (end of document)` };
      }),
  });
  console.log(JSON.stringify({ label, ms: Math.round(performance.now() - t0), streamedChars: streamed, toolCalls: calls, answer: result.fullText.slice(0, 200) }));
  return result.fullText;
}

const q1 = "Please read document NDA-7 and confirm in one short sentence that you read it.";
const a1 = await turn("turn1-tool", [{ role: "user", content: q1 }], [readDocument]);
const q2 = "Without using any tools: what is the escrow agent's code word in NDA-7?";
const history2: LlmMessage[] = [{ role: "user", content: q1 }, { role: "assistant", content: a1 }, { role: "user", content: q2 }];
const a2 = await turn("turn2-recall", history2, []);
const a3 = await turn("turn3-regenerate", history2, []);

const { harness } = await piRuntime();
const lineage = await harness.snapshot(
  (await import("@earendil-works/pi-durable")).defineDocFamily({ kind: "mike.chat", version: 1, scope: "session", family: true, initial: () => ({ conversations: [] as number[] }) }) as never,
  chatId,
  context,
);
console.log(JSON.stringify({
  secret: SECRET,
  turn2Recalled: a2.includes(SECRET),
  turn3Recalled: a3.includes(SECRET),
  toolRuns,
  lineage,
}));
for (const id of (lineage as any).conversations) {
  const c = await harness.conversation(id, context);
  const view = await c!.context(context);
  console.log(`conversation ${id}:`, view.messages.map((m: any) => `${m.role}${m.role === "system" ? `(+${(m.toolsAdded ?? []).map((t: any) => t.name)} -${(m.toolsRemoved ?? []).map((t: any) => t.name)})` : ""}:${JSON.stringify(m.content).slice(0, 70)}`).join("\n   "));
}
await harness.close(context);
