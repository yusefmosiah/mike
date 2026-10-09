/**
 * Behavioral tests for OpenCode Go token-triggered compaction inside
 * streamAiSdk: the preflight replay checkpoint, the post-turn / tool-loop
 * boundary checkpoint (including oversized newest tool results against a
 * provider request-size limit), and the single bounded context-overflow
 * recovery — its text-only continuation for a failed step's emitted prose,
 * and its refusal when the failed step already dispatched tool executions
 * that never reached the transcript. Everything drives the real adapter
 * through the shared MockLanguageModelV3 fixture — no network, no keys.
 */
import { describe, expect, it } from "vitest";
import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider" with {
  "resolution-mode": "import",
};
import type { MockLanguageModelV3 } from "ai/test" with {
  "resolution-mode": "import",
};

import { streamAiSdk, stopNotice, type AiSdkAdapterConfig } from "./aiSdk";
import type { LlmMessage, NormalizedToolCall, StreamChatParams } from "./types";
import {
  callStep,
  config,
  finish,
  makeModel,
  okRunTools,
  readsAsCancel,
  step,
  text,
  textStep,
  tick,
  toolCall,
  TOOLS,
  type Part,
} from "./__tests__/mockLanguageModel";

/** A finish part that reports the given provider usage for the step. */
const finishAt = (
  input: number,
  output: number,
  reason: "stop" | "tool-calls" | "length" = "stop",
): Part => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: 0 },
  },
});

const goConfig = (
  model: Parameters<typeof config>[0],
  modelId = "glm-5.3",
): AiSdkAdapterConfig => ({
  ...config(model),
  provider: "opencode-go",
  modelId,
});

/** Same model id but a non-OpenCode-Go route: only the gate can stop compaction. */
const otherRouteConfig = (model: Parameters<typeof config>[0]) => ({
  ...config(model),
  modelId: "glm-5.3",
});

/** ~100k tokens of older context: past the 20k-token retained tail. */
const blob = "z".repeat(400_000);
const oldContext: LlmMessage = {
  role: "user",
  content: `Earlier document review. ${blob}`,
};
const currentRequest: LlmMessage = {
  role: "user",
  content: "What are the deadlines?",
};

const chatParams = (
  messages: LlmMessage[],
  extra: Partial<StreamChatParams> = {},
): StreamChatParams => ({
  model: "opencode-go/glm-5.3",
  systemPrompt: "You are Mike.",
  messages,
  tools: TOOLS,
  maxIterations: 5,
  ...extra,
});

const overflowError = (message: string) =>
  Object.assign(new Error(message), {
    statusCode: 400,
    responseBody: `{"error":{"code":"context_length_exceeded"}}`,
  });

const CONTEXT_OVERFLOWS = [
  "This model's maximum context length is 1000000 tokens. However, you requested 1200000 tokens. Please reduce the length of the messages.",
  "prompt is too long: 213306 tokens > 200000 maximum",
  "The input token count (300000) exceeds the maximum number of tokens allowed (200000).",
  "This model's maximum context length is 1000000 tokens. However, you requested 1200000 tokens.",
];

const json = (value: unknown) => JSON.stringify(value);

const toolPairIds = (prompt: LanguageModelV3Prompt) => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of prompt) {
    const content = message.content;
    if (typeof content === "string") continue;
    for (const part of content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return { calls, results };
};

/** Every tool call in the prompt keeps its result, and vice versa. */
const expectCompleteToolPairs = (prompt: LanguageModelV3Prompt) => {
  const { calls, results } = toolPairIds(prompt);
  expect(results).toEqual(calls);
};

/** Assistant text parts in a request prompt, in message order. */
const assistantTexts = (prompt: LanguageModelV3Prompt) =>
  prompt.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
  );

/** A provider rejection whose only overflow signal is the explicit code. */
const codeOnlyOverflowError = (code: string) =>
  Object.assign(new Error("Request failed with status 400."), {
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "Request failed", code } }),
  });

/**
 * Reply per model request, with each stream built when doStream is called: a
 * ReadableStream's start() runs eagerly, so a reply that depends on request
 * timing (or on the prompt itself) must not be constructed any earlier.
 */
async function promptingModel(
  reply: (prompt: LanguageModelV3Prompt, call: number) => LanguageModelV3StreamResult,
): Promise<MockLanguageModelV3> {
  // Mirrors the shared fixture: the ESM-only test helper is loaded lazily.
  const { MockLanguageModelV3: Mock } = await import("ai/test");
  let calls = 0;
  return new Mock({
    doStream: async ({ prompt }: { prompt: LanguageModelV3Prompt }) => {
      calls += 1;
      return reply(prompt, calls);
    },
  });
}

/**
 * A promise with its resolver, for holding an executor open. Not
 * Promise.withResolvers: that is ES2024 and this config's lib is ES2022.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("preflight replay compaction", () => {
  it("is a no-op below the threshold: the next step keeps a byte-identical prefix", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("done"),
    ]);
    const result = await streamAiSdk(
      chatParams([{ role: "user", content: "go" }], { runTools: okRunTools }),
      goConfig(model),
    );
    expect(result.fullText).toBe("done");
    const [first, second] = model.doStreamCalls.map((call) => call.prompt);
    expect(json(first)).not.toContain("Context compacted");
    // No reshuffling: the earlier (untouched) prompt is an exact prefix.
    expect(second.slice(0, first.length)).toEqual(first);
    expect(json(second.slice(0, first.length))).toBe(json(first));
  });

  it(
    "replays the same compacted prefix when the raw transcript gains another turn",
    async () => {
      const hugeBlob = "y".repeat(3_300_000);
      const raw: LlmMessage[] = [
        { role: "user", content: `Background. ${hugeBlob}` },
        { role: "user", content: "List the dates." },
      ];
      const firstModel = await makeModel([textStep("First answer.")]);
      const first = await streamAiSdk(
        chatParams(raw, { runTools: okRunTools }),
        goConfig(firstModel),
      );
      expect(first.fullText).toBe("First answer.");
      const firstPrompt = firstModel.doStreamCalls[0].prompt;
      expect(json(firstPrompt)).toContain("Context compacted");
      expect(json(firstPrompt)).toContain("List the dates.");
      expect(json(firstPrompt)).not.toContain(hugeBlob);

      const grown: LlmMessage[] = [
        ...raw,
        { role: "assistant", content: "First answer." },
        { role: "user", content: "And the notice period?" },
      ];
      const secondModel = await makeModel([textStep("Second answer.")]);
      const second = await streamAiSdk(
        chatParams(grown, { runTools: okRunTools }),
        goConfig(secondModel),
      );
      expect(second.fullText).toBe("Second answer.");
      const secondPrompt = secondModel.doStreamCalls[0].prompt;
      expect(secondPrompt.slice(0, firstPrompt.length)).toEqual(firstPrompt);
      expect(json(secondPrompt.slice(0, firstPrompt.length))).toBe(
        json(firstPrompt),
      );
    },
    30_000,
  );
});

describe("configured compaction threshold", () => {
  it.each([["75", true], ["80", false]] as const)("applies %s percent to the actual provider context", async (percent, compacted) => {
    const previous = process.env.LLM_COMPACTION_THRESHOLD_PERCENT;
    process.env.LLM_COMPACTION_THRESHOLD_PERCENT = percent;
    try {
      const model = await makeModel([
        step(toolCall("c1", "read_document", { doc_id: "doc-0" }), finishAt(770_000, 0, "tool-calls")),
        textStep("done"),
      ]);
      await streamAiSdk(chatParams([oldContext, currentRequest], { runTools: okRunTools }), goConfig(model));
      const nextPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
      expect(nextPrompt.includes(blob)).toBe(!compacted);
      expect(nextPrompt.includes("Context compacted")).toBe(compacted);
      expectCompleteToolPairs(model.doStreamCalls[1].prompt);
    } finally {
      if (previous === undefined) delete process.env.LLM_COMPACTION_THRESHOLD_PERCENT;
      else process.env.LLM_COMPACTION_THRESHOLD_PERCENT = previous;
    }
  });
});

describe("post-turn checkpoints at the tool-loop boundary", () => {
  it("compacts on the latest provider usage and carries the new prefix forward", async () => {
    const model = await makeModel([
      step(
        toolCall("c1", "read_document", { doc_id: "doc-0" }),
        finishAt(900_000, 25, "tool-calls"),
      ),
      step(
        toolCall("c2", "read_document", { doc_id: "doc-1" }),
        finishAt(15, 5, "tool-calls"),
      ),
      textStep("done"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const result = await streamAiSdk(
      chatParams([oldContext, currentRequest], {
        runTools: async (calls: NormalizedToolCall[]) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      }),
      goConfig(model),
    );
    expect(result.fullText).toBe("done");
    expect(batches).toHaveLength(2);
    expect(model.doStreamCalls).toHaveLength(3);
    const [before, compacted, next] = model.doStreamCalls.map(
      (call) => call.prompt,
    );
    // The first step still carried the full history; the second was answered
    // with a checkpoint: summary first, current request and the completed
    // tool group verbatim.
    expect(json(before)).toContain(blob);
    expect(json(compacted)).not.toContain(blob);
    expect(json(compacted)).toContain("Context compacted");
    expect(json(compacted)).toContain("What are the deadlines?");
    expect(json(compacted)).toContain("doc read_document");
    expectCompleteToolPairs(compacted);
    // The compacted prefix survives the next boundary untouched; the second
    // step's small usage does not re-trigger or re-sum the older rounds.
    expect(next.slice(0, compacted.length)).toEqual(compacted);
    expect(json(next.slice(0, compacted.length))).toBe(json(compacted));
    expectCompleteToolPairs(next);
  });

  it("reduces an oversized newest tool result at the checkpoint, before the next request", async () => {
    const hugeResult = `huge tool result ${"r".repeat(3_300_000)}`;
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      callStep("c2", "read_document", { doc_id: "doc-1" }),
      textStep("done"),
    ]);
    const result = await streamAiSdk(
      chatParams([currentRequest], {
        runTools: async (calls: NormalizedToolCall[]) =>
          calls.map((call) => ({
            tool_use_id: call.id,
            content: call.id === "c1" ? hugeResult : "small result",
          })),
      }),
      goConfig(model),
    );
    expect(result.fullText).toBe("done");
    expect(model.doStreamCalls).toHaveLength(3);
    const [first, second, third] = model.doStreamCalls.map(
      (call) => call.prompt,
    );
    // Provider usage is tiny throughout; only the tool-result estimate can
    // cross the model's token trigger, and the oversized newest result is
    // reduced before it is ever sent — not after a later checkpoint.
    expect(json(first)).not.toContain(hugeResult);
    expect(json(second)).not.toContain(hugeResult);
    expect(json(second)).toContain("Context compacted");
    expect(json(second)).toContain("What are the deadlines?");
    expect(toolPairIds(second).results.has("c1")).toBe(true);
    expectCompleteToolPairs(second);
    // The reduced prefix carries into the next boundary; the small result and
    // the call/result identity both survive verbatim.
    expect(json(third)).not.toContain(hugeResult);
    expect(json(third)).toContain("small result");
    expect(toolPairIds(third).results.has("c1")).toBe(true);
    expectCompleteToolPairs(third);
  });
});

describe("oversized tool results against a provider request-size limit", () => {
  // ~4 chars/token: the window a real gateway enforces on the serialized
  // request, far below glm-5.3's 1M-token compaction band.
  const PROVIDER_CHAR_WINDOW = 400_000;
  const oversized = (chars: number) => `huge tool result ${"r".repeat(chars)}`;

  /** The provider answers an over-window request with an overflow rejection
   *  and scripts a tool call first, then "done" for requests that fit. */
  const windowedModel = async () => {
    const rejections: string[] = [];
    const model = await promptingModel((prompt, call) => {
      if (json(prompt).length > PROVIDER_CHAR_WINDOW) {
        rejections.push(json(prompt));
        return step({
          type: "error",
          error: codeOnlyOverflowError("context_length_exceeded"),
        });
      }
      return call === 1
        ? callStep("c1", "read_document", { doc_id: "doc-0" })
        : textStep("done");
    });
    return { model, rejections };
  };

  it("sends the next request below the window after a giant newest tool result", async () => {
    const hugeResult = oversized(3_300_000);
    const { model, rejections } = await windowedModel();
    const batches: NormalizedToolCall[][] = [];
    const result = await streamAiSdk(
      chatParams([currentRequest], {
        runTools: async (calls: NormalizedToolCall[]) => {
          batches.push(calls);
          return calls.map((call) => ({
            tool_use_id: call.id,
            content: hugeResult,
          }));
        },
      }),
      goConfig(model),
    );
    // The checkpoint reduced the result before the request was sent, so the
    // provider never had to reject it and no recovery was needed.
    expect(result.fullText).toBe("done");
    expect(rejections).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(2);
    const next = model.doStreamCalls[1].prompt;
    expect(json(next)).not.toContain(hugeResult);
    expect(json(next)).toContain("Context compacted");
    expect(toolPairIds(next).results.has("c1")).toBe(true);
    expectCompleteToolPairs(next);
  });

  it("forces a recovery below the character estimate when the provider rejects an over-window request", async () => {
    const mediumResult = oversized(500_000);
    const { model, rejections } = await windowedModel();
    const batches: NormalizedToolCall[][] = [];
    const result = await streamAiSdk(
      chatParams([currentRequest], {
        runTools: async (calls: NormalizedToolCall[]) => {
          batches.push(calls);
          return calls.map((call) => ({
            tool_use_id: call.id,
            content: mediumResult,
          }));
        },
      }),
      goConfig(model),
    );
    // The 500k-char result fits the token band and was sent verbatim, so the
    // provider rejected that request; the reported usage is tiny, so only the
    // character estimate can drive the forced reduction the retry needs.
    expect(result.fullText).toBe("done");
    expect(rejections).toHaveLength(1);
    expect(json(rejections[0])).toContain(mediumResult);
    expect(batches).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(3);
    const retry = model.doStreamCalls[2].prompt;
    expect(json(retry)).not.toContain(mediumResult);
    expect(json(retry)).toContain("Context compacted");
    expect(toolPairIds(retry).results.has("c1")).toBe(true);
    expectCompleteToolPairs(retry);
  });

  it.each([false, true])("sizes a forced reduction to a large active request (earlier exchange: %s)", async (withHistory) => {
    const activeRequest = "Read doc-0. " + "u".repeat(2_540_000);
    const output = "Older detail. ".repeat(30_000) + "\nFinal deadline: 2026-10-21.";
    const requestLimit = withHistory ? 2_561_000 : 2_559_000;
    const messages: LlmMessage[] = withHistory
      ? [
          { role: "user", content: "Earlier request about doc-0." },
          { role: "assistant", content: "Old background. ".repeat(1_000) },
          { role: "user", content: activeRequest },
        ]
      : [{ role: "user", content: activeRequest }];
    let executions = 0;
    let rejected = 0;
    const model = await promptingModel((prompt, call) => {
      if (JSON.stringify(prompt).length > requestLimit) {
        rejected++;
        return step({ type: "error", error: codeOnlyOverflowError("context_length_exceeded") });
      }
      return call === 1 ? callStep("c1", "read_document", { doc_id: "doc-0" }) : textStep("done");
    });
    const result = await streamAiSdk(chatParams(messages, {
      runTools: async (calls) => {
        executions += calls.length;
        return calls.map((call) => ({ tool_use_id: call.id, content: output }));
      },
    }), goConfig(model));
    expect(result.fullText).toBe("done");
    expect(executions).toBe(1);
    expect(rejected).toBe(1);
    const retry = model.doStreamCalls.at(-1)!.prompt;
    expect(JSON.stringify(retry).length).toBeLessThan(requestLimit);
    expect(JSON.stringify(retry)).toContain(activeRequest);
    expect(JSON.stringify(retry)).toContain("Final deadline: 2026-10-21.");
    expect(toolPairIds(retry).results.has("c1")).toBe(true);
    expectCompleteToolPairs(retry);
  });

  it.each([false, true])("budgets two retained tool pairs (quoted result: %s)", async (quoted) => {
    const activeRequest = "Read doc-0. " + "u".repeat(2_520_000);
    const secondOutput = (quoted
      ? '{"field":"quoted\\\\value"}\n'.repeat(12_000)
      : "d".repeat(500_000)) + "\nFinal deadline: 2026-10-21.";
    let executions = 0;
    let rejected = 0;
    const model = await promptingModel((prompt, call) => {
      if (JSON.stringify(prompt).length > 2_561_000) {
        rejected++;
        return step({ type: "error", error: codeOnlyOverflowError("context_length_exceeded") });
      }
      return call <= 2
        ? callStep(`c${call}`, "read_document", { doc_id: "doc-0" })
        : textStep("done");
    });
    const result = await streamAiSdk(chatParams([{ role: "user", content: activeRequest }], {
      runTools: async (calls) => {
        executions += calls.length;
        return calls.map((call) => ({
          tool_use_id: call.id,
          content: call.id === "c1" ? "First observation. " + "a".repeat(32_000) : secondOutput,
        }));
      },
    }), goConfig(model));
    expect(result.fullText).toBe("done");
    expect(executions).toBe(2);
    expect(rejected).toBe(1);
    const retry = model.doStreamCalls.at(-1)!.prompt;
    expect(JSON.stringify(retry).length).toBeLessThan(2_561_000);
    expect(JSON.stringify(retry)).toContain(activeRequest);
    expect(JSON.stringify(retry)).toContain("First observation.");
    expect(JSON.stringify(retry)).toContain("Final deadline: 2026-10-21.");
    expect(toolPairIds(retry).results.has("c1")).toBe(true);
    expect(toolPairIds(retry).results.has("c2")).toBe(true);
    expectCompleteToolPairs(retry);
  });
});

describe("bounded context-overflow recovery", () => {
  it.each(CONTEXT_OVERFLOWS)(
    "retries once on an explicit context-window rejection (%s)",
    async (message) => {
      const error = overflowError(message);
      const model = await makeModel([
        callStep("c1", "read_document", { doc_id: "doc-0" }),
        step(...text("partial"), { type: "error", error }),
        textStep("recovered"),
      ]);
      const batches: NormalizedToolCall[][] = [];
      const result = await streamAiSdk(
        chatParams([oldContext, currentRequest], {
          runTools: async (calls: NormalizedToolCall[]) => {
            batches.push(calls);
            return okRunTools(calls);
          },
        }),
        goConfig(model),
      );
      // Emitted text is preserved, the completed tool ran exactly once, and
      // the retry prompt is a real reduction that still contains the tool
      // result so the model does not repeat the call. The failed step's
      // streamed prose rides along as a text-only continuation.
      expect(result.fullText).toBe("partialrecovered");
      expect(batches).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(3);
      const retry = model.doStreamCalls[2].prompt;
      expect(json(retry)).toContain("Context compacted");
      expect(json(retry)).not.toContain(blob);
      expect(json(retry)).toContain("What are the deadlines?");
      expect(json(retry)).toContain("doc read_document");
      expect(assistantTexts(retry)).toEqual(["partial"]);
      expectCompleteToolPairs(retry);
    },
    30_000,
  );

  it("recovers from a combined prompt/completion context overflow without misclassifying it as an output cap", async () => {
    const error = Object.assign(new Error(
      "The maximum context length is 1000000 tokens but the prompt plus 100000 completion tokens exceeds this context window.",
    ), { statusCode: 400 });
    const model = await makeModel([
      step({ type: "error", error }),
      textStep("recovered"),
    ]);
    const result = await streamAiSdk(chatParams([oldContext, currentRequest]), goConfig(model));
    expect(result.fullText).toBe("recovered");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("What are the deadlines?");
  });

  it.each(["context_length_exceeded", "context_window_exceeded"])(
    "retries once on the explicit overflow code %s with generic prose",
    async (code) => {
      const model = await makeModel([
        callStep("c1", "read_document", { doc_id: "doc-0" }),
        step(...text("partial"), {
          type: "error",
          error: codeOnlyOverflowError(code),
        }),
        textStep("recovered"),
      ]);
      const batches: NormalizedToolCall[][] = [];
      const result = await streamAiSdk(
        chatParams([oldContext, currentRequest], {
          runTools: async (calls: NormalizedToolCall[]) => {
            batches.push(calls);
            return okRunTools(calls);
          },
        }),
        goConfig(model),
      );
      expect(result.fullText).toBe("partialrecovered");
      expect(batches).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(3);
      const retry = model.doStreamCalls[2].prompt;
      expect(json(retry)).toContain("Context compacted");
      expect(json(retry)).not.toContain(blob);
      expect(json(retry)).toContain("What are the deadlines?");
      expect(json(retry)).toContain("doc read_document");
      expect(assistantTexts(retry)).toEqual(["partial"]);
      expectCompleteToolPairs(retry);
    },
    30_000,
  );

  it("spends only the remaining iteration budget on the retry", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      step({ type: "error", error }),
      callStep("c2", "read_document", { doc_id: "doc-1" }),
      textStep("must not be requested"),
    ]);
    const result = await streamAiSdk(
      chatParams([oldContext, currentRequest], {
        runTools: okRunTools,
        maxIterations: 3,
      }),
      goConfig(model),
    );
    expect(model.doStreamCalls).toHaveLength(3);
    expect(result.fullText).toBe(stopNotice(3, 3, "tool-calls"));
  });

  it("rethrows the untouched error when the transcript cannot be reduced", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await makeModel([
      step({ type: "error", error }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([{ role: "user", content: "hi" }], {
          runTools: okRunTools,
        }),
        goConfig(model),
      ),
    ).rejects.toBe(error);
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("retries at most once: a second overflow propagates unchanged", async () => {
    const first = overflowError(CONTEXT_OVERFLOWS[0]);
    const second = overflowError(
      "prompt is too long: 1500000 tokens > 1000000 maximum",
    );
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      step({ type: "error", error: first }),
      step({ type: "error", error: second }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], { runTools: okRunTools }),
        goConfig(model),
      ),
    ).rejects.toBe(second);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it.each([
    [
      "an invalid-request rejection",
      Object.assign(new Error("invalid request: tool schema malformed"), {
        statusCode: 400,
      }),
    ],
    [
      "an output-length rejection",
      Object.assign(
        new Error(
          "max_tokens: 300000 is too large; this model supports at most 128000 completion tokens",
        ),
        { statusCode: 400 },
      ),
    ],
    [
      "an output-limit rejection accompanied by context-window metadata",
      Object.assign(new Error("max_tokens is too large; maximum completion tokens is 128000"), {
        statusCode: 400,
        responseBody: '{"error":{"code":"max_tokens_too_large"},"limits":{"context_window":1000000}}',
      }),
    ],
    [
      "an output-token rejection with generic too-many-tokens wording",
      Object.assign(new Error("Too many tokens requested for output; maximum completion tokens is 128000"), {
        statusCode: 400,
      }),
    ],
    [
      "a validation error with context-window metadata but no overflow",
      Object.assign(new Error("Invalid tool schema."), {
        statusCode: 400,
        data: { limits: { context_window: 1_000_000 } },
      }),
    ],
    [
      "context metadata followed by an output setting exceeding its limit",
      Object.assign(new Error("Invalid request."), {
        statusCode: 400,
        responseBody:
          '{"limits":{"context_window":1000000},"error":{"code":"invalid_request_error","message":"max_tokens exceeds the model output limit"}}',
      }),
    ],
    [
      "context metadata followed by a tool schema exceeding its limit",
      Object.assign(new Error("Invalid request."), {
        statusCode: 400,
        responseBody:
          '{"limits":{"context_window":1000000},"error":{"code":"invalid_request_error","message":"tool schema exceeds the nesting limit"}}',
      }),
    ],
    [
      "space-separated context metadata followed by an unrelated exceeded limit",
      Object.assign(new Error("Invalid request."), {
        statusCode: 400,
        responseBody:
          '{"limits":{"context window":1000000},"error":{"code":"invalid_request_error","message":"tool schema exceeds the nesting limit"}}',
      }),
    ],
    [
      "overflow help text in non-error metadata",
      Object.assign(new Error("Invalid tool schema."), {
        statusCode: 400,
        data: { limits: { help: "maximum context window exceeded" } },
      }),
    ],
    [
      "context description followed by an unrelated exceeded limit in prose",
      Object.assign(new Error("Context window is 1000000 tokens; tool schema exceeds the nesting limit."), {
        statusCode: 400,
      }),
    ],
    [
      "an unrelated exceeded limit followed by context information",
      Object.assign(new Error("Tool nesting exceeded its limit; the context window is 1000000 tokens."), {
        statusCode: 400,
      }),
    ],
    [
      "requested input below the described context limit",
      Object.assign(new Error("Maximum context length is 1000000 tokens; you requested 500000 tokens. Invalid tool schema."), {
        statusCode: 400,
      }),
    ],
    [
      "context-shaped wrapper around a permission failure",
      new Error("context_length_exceeded", {
        cause: Object.assign(new Error("Request denied."), { statusCode: 403 }),
      }),
    ],
    ...[
      "Invalid input: tool schema exceeds the nesting limit (context window: 1000000 tokens).",
      "Input schema exceeds its nesting limit, but the context window is 1000000 tokens.",
      "Input schema exceeds the nesting limit for this model (context window: 1000000 tokens).",
    ].map((message) => [
      "input validation with unrelated context information",
      Object.assign(new Error(message), { statusCode: 400 }),
    ]),
    [
      "an overflow code whose body also reads as a rate limit",
      Object.assign(new Error("Request failed with status 400."), {
        statusCode: 400,
        responseBody:
          '{"error":{"code":"context_length_exceeded","message":"rate limit exceeded, retry later"}}',
      }),
    ],
    [
      "an overflow code behind a non-400 status",
      Object.assign(new Error("Bad gateway."), {
        statusCode: 502,
        responseBody: '{"error":{"code":"context_window_exceeded"}}',
      }),
    ],
  ])("does not retry on %s", async (_name, error) => {
    const model = await makeModel([
      step({ type: "error", error }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], { runTools: okRunTools }),
        goConfig(model),
      ),
    ).rejects.toBe(error);
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("keeps auth guidance and never retries on it", async () => {
    const error = Object.assign(new Error("invalid api key provided"), {
      statusCode: 401,
    });
    const model = await makeModel([
      step({ type: "error", error }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], { runTools: okRunTools }),
        goConfig(model),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("rejected") });
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("never spends the retry on a tool fault, even when its text reads like an overflow", async () => {
    const failure = Object.assign(
      new Error("prompt is too long: 1500000 tokens > 1000000 maximum"),
      { statusCode: 400 },
    );
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], {
          runTools: async () => {
            throw failure;
          },
        }),
        goConfig(model),
      ),
    ).rejects.toBe(failure);
    await tick();
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("does not retry a provider failure that reads as a cancel", async () => {
    const providerError = Object.assign(
      new Error("prompt is too long: 1500000 tokens > 1000000 maximum"),
      { name: "AbortError" },
    );
    const model = await makeModel([
      step({ type: "error", error: providerError }),
      textStep("must not be requested"),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk(
        chatParams([oldContext, currentRequest], { runTools: okRunTools }),
        goConfig(model),
      );
    } catch (error) {
      caught = error;
    }
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(readsAsCancel(caught)).toBe(false);
    expect(caught instanceof Error ? caught.cause : undefined).toBe(
      providerError,
    );
  });

  it("does not retry after the caller cancels mid-turn", async () => {
    const abort = new AbortController();
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must not be requested"),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk(
        chatParams([oldContext, currentRequest], {
          abortSignal: abort.signal,
          runTools: async (calls: NormalizedToolCall[]) => {
            abort.abort();
            return okRunTools(calls);
          },
        }),
        goConfig(model),
      );
    } catch (error) {
      caught = error;
    }
    expect(readsAsCancel(caught)).toBe(true);
    await tick();
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("still recovers when the failed step only announced a tool call it never executed", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await makeModel([
      step(
        ...text("partial"),
        toolCall("c1", "read_document", { doc_id: "doc-0" }),
        { type: "error", error },
      ),
      textStep("recovered"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const result = await streamAiSdk(
      chatParams([oldContext, currentRequest], {
        runTools: async (calls: NormalizedToolCall[]) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      }),
      goConfig(model),
    );
    // The call was announced to the client but runTools never saw it, so no
    // side effect is unrepresented and the bounded recovery still runs.
    expect(result.fullText).toBe("partialrecovered");
    expect(batches).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(2);
    const retry = model.doStreamCalls[1].prompt;
    expect(json(retry)).toContain("Context compacted");
    expect(json(retry)).not.toContain(blob);
    expect(assistantTexts(retry)).toEqual(["partial"]);
    // The announced call never became a message, so no orphan pair is sent.
    expect(toolPairIds(retry)).toEqual({
      calls: new Set(),
      results: new Set(),
    });
    expectCompleteToolPairs(retry);
  });

  it("keeps a completed step's prose and the failed step's partial exactly once", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await makeModel([
      step(
        ...text("first answer"),
        toolCall("c1", "read_document", { doc_id: "doc-0" }),
        finish("tool-calls"),
      ),
      step(...text("second partial"), { type: "error", error }),
      textStep("recovered"),
    ]);
    const result = await streamAiSdk(
      chatParams([oldContext, currentRequest], { runTools: okRunTools }),
      goConfig(model),
    );
    expect(result.fullText).toBe("first answersecond partialrecovered");
    const retry = model.doStreamCalls[2].prompt;
    // The committed step's prose comes from its response message; the failed
    // step's prose rides along as the text-only continuation. Neither doubles,
    // and the committed tool pair is complete.
    expect(assistantTexts(retry)).toEqual(["first answer", "second partial"]);
    expectCompleteToolPairs(retry);
  });
});

describe("recovery refusal when a failed step already ran tools", () => {
  /** Tool call and tool-calls finish, then the overflow in the same stream:
   *  the SDK dispatches execution from the finish part and serializes the
   *  later failure behind it, so the execution is under way when the failure
   *  lands. The stream is built by the reply, i.e. when doStream is called. */
  const failedAfterExecution = (
    error: Error,
  ): LanguageModelV3StreamResult => ({
    stream: new ReadableStream<Part>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({
          type: "response-metadata",
          id: "resp",
          modelId: "mock",
        });
        controller.enqueue(toolCall("c1", "read_document", { doc_id: "doc-0" }));
        controller.enqueue(finish("tool-calls"));
        controller.enqueue({ type: "error", error });
        controller.close();
      },
    }),
  });

  it("refuses recovery when the failed step already dispatched its execution", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await promptingModel(() => failedAfterExecution(error));
    const batches: NormalizedToolCall[][] = [];
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], {
          runTools: async (calls: NormalizedToolCall[]) => {
            batches.push(calls);
            return okRunTools(calls);
          },
        }),
        goConfig(model),
      ),
    ).rejects.toBe(error);
    await tick();
    // The execution's result never reached the transcript, so a retry would
    // re-ask the model and re-run the side effect; it must not happen.
    expect(batches).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("refuses recovery while the failed step's execution is still in flight", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const released = deferred();
    const dispatched = deferred();
    const model = await promptingModel(() => failedAfterExecution(error));
    const batches: NormalizedToolCall[][] = [];
    const run = streamAiSdk(
      chatParams([oldContext, currentRequest], {
        runTools: (calls: NormalizedToolCall[]) => {
          batches.push(calls);
          dispatched.resolve();
          return released.promise.then(() => okRunTools(calls));
        },
      }),
      goConfig(model),
    );
    const settled = run.then(
      () => "completed",
      (caught: unknown) => caught,
    );
    // Hold the executor open while the provider failure waits behind it, then
    // release: the dispatch is still never checkpointed, so recovery must
    // refuse instead of re-asking the model and re-running the side effect.
    await dispatched.promise;
    released.resolve();
    expect(await settled).toBe(error);
    await tick();
    expect(batches).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("route isolation", () => {
  it("leaves a non-OpenCode-Go route untouched even past the model's threshold", async () => {
    const model = await makeModel([
      step(
        toolCall("c1", "read_document", { doc_id: "doc-0" }),
        finishAt(900_000, 25, "tool-calls"),
      ),
      textStep("done"),
    ]);
    const result = await streamAiSdk(
      chatParams([oldContext, currentRequest], { runTools: okRunTools }),
      otherRouteConfig(model),
    );
    expect(result.fullText).toBe("done");
    const nextPrompt = model.doStreamCalls[1].prompt;
    expect(json(nextPrompt)).toContain(blob);
    expect(json(nextPrompt)).not.toContain("Context compacted");
  });

  it("never recovers from an overflow outside the OpenCode Go route", async () => {
    const error = overflowError(CONTEXT_OVERFLOWS[0]);
    const model = await makeModel([
      step({ type: "error", error }),
      textStep("must not be requested"),
    ]);
    await expect(
      streamAiSdk(
        chatParams([oldContext, currentRequest], { runTools: okRunTools }),
        otherRouteConfig(model),
      ),
    ).rejects.toBe(error);
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
