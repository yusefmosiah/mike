/**
 * Vision-lane compaction through the real streamAiSdk adapter on an OpenCode
 * Go focus model that accepts images. A checkpoint forced by provider usage
 * must hand the next model request the archived history as real PNG file
 * parts — and must fall back to a text-only summary when that archive cannot
 * be framed (non-ASCII text, or an anchor that alone overflows the frame
 * budget).
 *
 * Every scenario also pins what the consumer depends on across a compaction:
 * the active request message survives byte-for-byte, every tool call keeps its
 * result, and the caller's transcript is never mutated.
 */
import { describe, expect, it } from "vitest";
import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider" with {
  "resolution-mode": "import",
};

import { streamAiSdk, type AiSdkAdapterConfig } from "./aiSdk";
import type { LlmMessage, StreamChatParams } from "./types";
import {
  config,
  makeModel,
  okRunTools,
  step,
  textStep,
  toolCall,
  TOOLS,
  type Part,
} from "./__tests__/mockLanguageModel";

/** The vision-enabled OpenCode Go focus model: 1M window, 800k trigger. */
const VISION_MODEL = "opencode-go/glm-5.3-flash";
const VISION_MODEL_ID = "glm-5.3-flash";

/** A real 1x1 PNG — the caller's attached image. */
const ATTACHED_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** PNG signature plus the IHDR chunk header: the start of any real PNG. */
const PNG_HEADER = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
];

/**
 * ~75k tokens of disposable assistant prose: neither a user request nor an
 * error turn, so archive compression drops it first — which is what keeps the
 * surviving ASCII requests inside the eight-frame budget.
 */
const FILLER = `Disposable assistant filler. ${"x".repeat(300_000)}`;

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

const chatParams = (
  messages: LlmMessage[],
  extra: Partial<StreamChatParams> = {},
): StreamChatParams => ({
  model: VISION_MODEL,
  systemPrompt: "You are Mike.",
  messages,
  tools: TOOLS,
  maxIterations: 5,
  ...extra,
});

const visionConfig = (
  model: Parameters<typeof config>[0],
): AiSdkAdapterConfig => ({
  ...config(model),
  provider: "opencode-go",
  modelId: VISION_MODEL_ID,
});

const bytesEqual = (data: unknown, expected: Uint8Array): boolean =>
  data instanceof Uint8Array &&
  data.length === expected.length &&
  expected.every((byte, index) => data[index] === byte);

/** The PNG prefix of a file part's raw bytes, or null when it is not bytes. */
const pngHeader = (data: unknown): number[] | null =>
  data instanceof Uint8Array && data.length >= PNG_HEADER.length
    ? Array.from(data.slice(0, PNG_HEADER.length))
    : null;

/** Image parts the provider prompt actually carries, across all messages. */
const fileParts = (
  prompt: LanguageModelV3Prompt,
): LanguageModelV3FilePart[] => {
  const parts: LanguageModelV3FilePart[] = [];
  for (const message of prompt) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "file") parts.push(part);
    }
  }
  return parts;
};

/** User messages whose text parts include the given request verbatim. */
const messagesWithText = (prompt: LanguageModelV3Prompt, text: string) =>
  prompt.filter(
    (message) =>
      message.role === "user" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) => part.type === "text" && part.text === text,
      ),
  );

/** Tool call ids and tool result ids, in prompt order. */
const toolPairIds = (prompt: LanguageModelV3Prompt) => {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of prompt) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.push(part.toolCallId);
      if (part.type === "tool-result") results.push(part.toolCallId);
    }
  }
  return { calls, results };
};

/** Every tool call in the prompt keeps its result, and vice versa. */
const expectCompleteToolPairs = (prompt: LanguageModelV3Prompt) => {
  const { calls, results } = toolPairIds(prompt);
  expect(results).toEqual(calls);
};

/**
 * One scripted vision turn: a tool round whose provider usage (900k tokens,
 * past the model's 800k trigger) forces the checkpoint at the tool-loop
 * boundary, then a closing text step. Returns the prompt the SDK sent before
 * the checkpoint and the one the next step actually carried.
 */
const runVisionCompactionTurn = async (messages: LlmMessage[]) => {
  const model = await makeModel([
    step(
      toolCall("c1", "read_document", { doc_id: "doc-0" }),
      finishAt(900_000, 25, "tool-calls"),
    ),
    textStep("done"),
  ]);
  const params = chatParams(messages, { runTools: okRunTools });
  const result = await streamAiSdk(params, visionConfig(model));
  expect(result.fullText).toBe("done");
  expect(model.doStreamCalls).toHaveLength(2);
  const [beforeCheckpoint, afterCheckpoint] = model.doStreamCalls.map(
    (call) => call.prompt,
  );
  return { params, beforeCheckpoint, afterCheckpoint };
};

describe("compaction media accounting through the adapter", () => {
  it("sends the archived ASCII history as PNG frames, keeping the active request and tool pair verbatim", async () => {
    const olderRequest =
      "Older request: summarize the termination provisions in doc-42 and the notice periods.";
    const activeRequest = "Which clause controls termination?";
    const messages: LlmMessage[] = [
      { role: "user", content: olderRequest },
      { role: "assistant", content: FILLER },
      {
        role: "user",
        content: [
          { type: "text", text: activeRequest },
          {
            type: "image",
            image: ATTACHED_PNG,
            mimeType: "image/png",
            fallbackText: "[termination clause screenshot]",
          },
        ],
      },
    ];
    const callerSnapshot = structuredClone(messages);

    const { params, beforeCheckpoint, afterCheckpoint } =
      await runVisionCompactionTurn(messages);

    // The trigger is the provider's 900k usage, not the raw estimate: the
    // first request still carried the entire history, with the caller's
    // attachment as the only file part.
    expect(JSON.stringify(beforeCheckpoint)).toContain(FILLER);
    expect(JSON.stringify(beforeCheckpoint)).not.toContain("Context compacted");
    expect(fileParts(beforeCheckpoint)).toHaveLength(1);

    // The next request drops the filler and ships the archive both ways: the
    // summary text keeps the archived request readable, the frames keep it
    // renderable, and the completed tool result stays with its call.
    expect(JSON.stringify(afterCheckpoint)).toContain("Context compacted");
    expect(JSON.stringify(afterCheckpoint)).not.toContain(FILLER);
    expect(JSON.stringify(afterCheckpoint)).toContain(olderRequest);
    expect(JSON.stringify(afterCheckpoint)).toContain("doc read_document");
    const frames = fileParts(afterCheckpoint).filter(
      (part) => !bytesEqual(part.data, ATTACHED_PNG),
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.mediaType).toBe("image/png");
      expect(pngHeader(frame.data)).toEqual(PNG_HEADER);
    }

    // The active request is the caller's message byte-for-byte — same text,
    // same raw PNG bytes, as a file part of that very message.
    const activeMessages = messagesWithText(afterCheckpoint, activeRequest);
    expect(activeMessages).toHaveLength(1);
    const activeFiles = fileParts(activeMessages);
    expect(activeFiles).toHaveLength(1);
    expect(activeFiles[0].mediaType).toBe("image/png");
    expect(bytesEqual(activeFiles[0].data, ATTACHED_PNG)).toBe(true);

    // No orphaned tool call or result reaches the provider.
    expectCompleteToolPairs(afterCheckpoint);

    // The caller's transcript is untouched: still raw, still no marker.
    expect(params.messages).toEqual(callerSnapshot);
    expect(JSON.stringify(params.messages)).toContain(FILLER);
    expect(JSON.stringify(params.messages)).not.toContain("Context compacted");
  });

  it("falls back to a text-only summary when the archived request is not ASCII", async () => {
    const olderRequest =
      "Revisión del contrato: la cláusula de terminación prevalece — café.";
    const activeRequest = "Which clause controls termination?";
    const messages: LlmMessage[] = [
      { role: "user", content: olderRequest },
      { role: "assistant", content: FILLER },
      { role: "user", content: activeRequest },
    ];
    const callerSnapshot = structuredClone(messages);

    const { params, beforeCheckpoint, afterCheckpoint } =
      await runVisionCompactionTurn(messages);

    expect(JSON.stringify(beforeCheckpoint)).toContain(FILLER);
    expect(fileParts(beforeCheckpoint)).toHaveLength(0);

    // The checkpoint still fires; the archive simply cannot be rasterized
    // without substituting glyphs, so the non-ASCII request rides in the
    // summary text and no file part is sent.
    expect(JSON.stringify(afterCheckpoint)).toContain("Context compacted");
    expect(JSON.stringify(afterCheckpoint)).not.toContain(FILLER);
    expect(JSON.stringify(afterCheckpoint)).toContain("cláusula de terminación");
    expect(fileParts(afterCheckpoint)).toHaveLength(0);

    expect(messagesWithText(afterCheckpoint, activeRequest)).toHaveLength(1);
    expectCompleteToolPairs(afterCheckpoint);
    expect(params.messages).toEqual(callerSnapshot);
    expect(JSON.stringify(params.messages)).toContain(olderRequest);
  });

  it("falls back to a text-only summary when the ASCII anchor alone overflows the frame budget", async () => {
    const anchor = `Oversized ASCII anchor: ${"A".repeat(100_000)}`;
    const activeRequest = "Quote the termination clause.";
    const messages: LlmMessage[] = [
      { role: "user", content: anchor },
      { role: "user", content: activeRequest },
    ];
    const callerSnapshot = structuredClone(messages);

    const { params, beforeCheckpoint, afterCheckpoint } =
      await runVisionCompactionTurn(messages);

    // Nothing but the provider usage could have triggered this: the raw
    // prompt is a fraction of the window and carries the anchor whole.
    expect(JSON.stringify(beforeCheckpoint)).toContain(anchor);
    expect(JSON.stringify(beforeCheckpoint)).not.toContain("Context compacted");
    expect(fileParts(beforeCheckpoint)).toHaveLength(0);

    // Eight frames cap at 48k characters and a user turn cannot be dropped,
    // so the archive is not rasterized: the summary truncates the request
    // head — one bounded text block instead of one enormous final image.
    expect(JSON.stringify(afterCheckpoint)).toContain("Context compacted");
    expect(JSON.stringify(afterCheckpoint)).toContain("Oversized ASCII anchor:");
    expect(JSON.stringify(afterCheckpoint)).toContain("[...truncated]");
    expect(JSON.stringify(afterCheckpoint)).not.toContain(anchor);
    expect(fileParts(afterCheckpoint)).toHaveLength(0);

    expect(messagesWithText(afterCheckpoint, activeRequest)).toHaveLength(1);
    expectCompleteToolPairs(afterCheckpoint);
    expect(params.messages).toEqual(callerSnapshot);
    expect(JSON.stringify(params.messages)).toContain(anchor);
  });
});
