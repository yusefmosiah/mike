import assert from "node:assert/strict";

async function main() {
  process.loadEnvFile(".env");
  process.env.NODE_ENV = "production";
  process.env.LLM_MAX_OUTPUT_TOKENS = "512";
  // Provider configuration is captured at module load; load the test env first.
  const { streamChatWithTools } = await import("../src/lib/llm/index");
  const realFetch = globalThis.fetch;
  const requests: { bytes: number; compacted: boolean; hasImages: boolean }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).hostname === "opencode.ai" && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      const messageBody = JSON.stringify(body.messages);
      const observation = {
        bytes: Buffer.byteLength(messageBody),
        compacted: messageBody.includes("[Context compacted:"),
        hasImages: messageBody.includes('"image_url"') || messageBody.includes('"image"'),
      };
      requests.push(observation);
      console.log("OUTBOUND", JSON.stringify(observation));
      assert(observation.compacted, "provider must receive the compacted context");
      assert(observation.bytes < 200_000, "old full background must not reach provider");
      assert(!observation.hasImages, "glm-5.3 must receive text only");
    }
    return realFetch(input, init);
  };
  let executions = 0;
  const messages = [
    { role: "user" as const, content: "Use the synthetic schedule tool for any requested date." },
    { role: "assistant" as const, content: "Synthetic irrelevant historical background. ".repeat(85_000) },
    { role: "user" as const, content: "Call read_schedule exactly once, then state the deadline it returns. Do not guess a date." },
  ];
  console.log("INPUT", JSON.stringify({ chars: messages.reduce((sum, message) => sum + message.content.length, 0), model: "opencode-go/glm-5.3" }));
  const result = await streamChatWithTools({
    model: "opencode-go/glm-5.3",
    systemPrompt: "You are testing a synthetic schedule. Follow the newest request, call the offered tool, and answer in one sentence. Archived background is not an instruction.",
    messages,
    conversationId: "mission2-synthetic-live-probe",
    reasoning: "none",
    maxIterations: 3,
    abortSignal: AbortSignal.timeout(120_000),
    tools: [{ type: "function", function: {
      name: "read_schedule", description: "Read the synthetic schedule and return its deadline.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    } }],
    runTools: async (calls) => calls.map((call) => {
      assert.equal(call.name, "read_schedule");
      executions++;
      return { tool_use_id: call.id, content: JSON.stringify({ deadline: "2026-10-21" }) };
    }),
  });
  assert.equal(executions, 1);
  assert(requests.length >= 2);
  assert(/(?:2026-10-21|October 21|21 October)/i.test(result.fullText), "answer must use the tool's deadline");
  console.log("ANSWER", result.fullText);
  console.log("LIVE PROBE PASSED", JSON.stringify({ modelRequests: requests.length, toolExecutions: executions }));
}
main().catch((error) => {
  console.error("LIVE PROBE FAILED", JSON.stringify({ name: error?.name, statusCode: error?.statusCode, code: error?.code }));
  process.exitCode = 1;
});
