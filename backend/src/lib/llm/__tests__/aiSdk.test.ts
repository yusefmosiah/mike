import { describe, expect, it } from "vitest";
import { withPrefixCacheHints } from "../aiSdk";

const messages = [
  { role: "user" as const, content: "memory" },
  { role: "assistant" as const, content: "ok" },
  { role: "user" as const, content: "question" },
];

describe("withPrefixCacheHints", () => {
  it("sends no cache hints for one-shot calls", () => {
    const hints = withPrefixCacheHints({
      model: "gpt-5",
      systemPrompt: "s",
      messages,
    });
    expect(hints.providerOptions).toBeUndefined();
    // String-only content is passed through semantically unchanged; the
    // adapter re-copies messages because it now translates LlmMessage to the
    // AI SDK model-message shape on every call.
    expect(hints.messages).toEqual(messages);
  });

  it("sends image parts as raw file parts to a vision model", () => {
    const image = Buffer.from("fake-image-bytes");
    const hints = withPrefixCacheHints({
      model: "opencode-go/kimi-k3",
      systemPrompt: "s",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              image,
              mimeType: "image/png",
              fallbackText: "[chart screenshot]",
            },
          ],
        },
      ],
    });
    expect(hints.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          // Never base64-encoded: the provider adapter encodes transport.
          { type: "file", data: image, mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("replaces image parts with fallback text for a text-only model", () => {
    const hints = withPrefixCacheHints({
      model: "opencode-go/glm-5.3",
      systemPrompt: "s",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              image: Buffer.from("fake-image-bytes"),
              fallbackText: "[chart screenshot]",
            },
          ],
        },
      ],
    });
    expect(hints.messages).toEqual([
      { role: "user", content: "describe this\n\n[chart screenshot]" },
    ]);
  });

  it("defaults to an image/png media type when the part does not name one", () => {
    const hints = withPrefixCacheHints(
      {
        model: "opencode-go/minimax-m3",
        systemPrompt: "s",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: "aGVsbG8=",
                fallbackText: "[image]",
              },
            ],
          },
        ],
      },
      true,
    );
    expect(hints.messages).toEqual([
      {
        role: "user",
        content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }],
      },
    ]);
  });

  it("keys the OpenAI cache by conversation and marks an Anthropic breakpoint on the last turn", () => {
    const hints = withPrefixCacheHints({
      model: "gpt-5",
      systemPrompt: "s",
      messages,
      conversationId: "chat-1",
    });
    expect(hints.providerOptions).toEqual({
      openai: { promptCacheKey: "chat-1" },
    });
    // Only the final message carries the breakpoint: Anthropic caches
    // everything before it, and an earlier breakpoint would be wasted.
    expect(hints.messages.slice(0, -1).every((m) => !m.providerOptions)).toBe(
      true,
    );
    expect(hints.messages.at(-1)).toEqual({
      role: "user",
      content: "question",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});
