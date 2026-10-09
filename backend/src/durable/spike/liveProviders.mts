// Live check: Mike model ids through the pi-ai catalog, one tool round and one
// title each. Pick ids that cover each wire protocol you care about:
//
//   npx tsx src/durable/spike/liveProviders.mts opencode-go/glm-5.3 opencode-go/minimax-m3 \
//     opencode-go/muse-spark-1.3-contributor openrouter/google/gemini-2.5-flash-lite
import { completeTextOnPi, streamChatWithToolsOnPi } from "../../lib/llm/pi/runtime.mjs";
import type { OpenAIToolSchema } from "../../lib/llm/types.js";
process.loadEnvFile(".env");
const tool: OpenAIToolSchema = { type: "function", function: { name: "read_document", description: "Read a matter document by id.", parameters: { type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] } } };
const models = process.argv.slice(2);
for (const model of models) {
  const t0 = performance.now();
  try {
    let streamed = 0; const calls: string[] = [];
    const turn = await streamChatWithToolsOnPi({
      model, systemPrompt: "You are Mike, a legal assistant. Be brief.", reasoning: "low", maxIterations: 3,
      messages: [{ role: "user", content: "Read document NDA-7 with the tool, then tell me its governing law in one sentence." }],
      tools: [tool],
      callbacks: { onContentDelta: (d) => (streamed += d.length), onToolCallStart: (c) => calls.push(c.name) },
      runTools: async (batch) => batch.map((c) => ({ tool_use_id: c.id, content: "NDA-7: This agreement is governed by the laws of Delaware." })),
    });
    const title = await completeTextOnPi({ model, systemPrompt: "Reply with a 3-word title only.", user: "Question about NDA governing law", maxTokens: 64 });
    console.log(JSON.stringify({ model, ok: true, ms: Math.round(performance.now() - t0), calls, streamed, delaware: /delaware/i.test(turn.fullText), answer: turn.fullText.slice(0, 120), title: title.trim().slice(0, 60) }));
  } catch (e) {
    console.log(JSON.stringify({ model, ok: false, error: (e as Error).message.slice(0, 300) }));
  }
}
