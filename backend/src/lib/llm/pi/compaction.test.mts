import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  clip,
  dominantScript,
  fallbackSummary,
  matchesPersonsScript,
  serializeForSummary,
  summaryInstructions,
  urlLedger,
  withLedger,
  writeSummary,
} from "./compaction.mjs";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const answer = (text: string, calls: Array<{ name: string; arguments: Record<string, string> }> = []): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private planning" },
    { type: "text", text },
    ...calls.map((call, index) => ({ type: "toolCall" as const, id: `c${index}`, ...call })),
  ],
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
});
const result = (toolName: string, text: string): Message => ({
  role: "toolResult",
  toolCallId: "c0",
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});
const earlierSummary = (text: string): Message =>
  user(`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${text}\n</summary>`);

const thread: Message[] = [
  user("Review this podcast for delusion: https://youtu.be/S6l3aRsecuE"),
  answer("I read the transcript.", [{ name: "fetch_web_page", arguments: { url: "https://mosiah.org/articles/everybodys-building-the-same-agent/" } }]),
  result("fetch_web_page", "Everybody's building the same agent. See https://example.com/source-only-in-a-result."),
  answer("Here is my review. 你好 is not here."),
  user("Notice they never say the word social."),
];

describe("the compaction summary", () => {
  it("serializes the transcript without the model's private thinking", () => {
    const text = serializeForSummary(thread);
    expect(text).toContain("[Person]\nReview this podcast");
    expect(text).toContain("[Assistant used fetch_web_page]");
    expect(text).toContain("[fetch_web_page returned]");
    expect(text).not.toContain("private planning");
    expect(serializeForSummary([earlierSummary("old")])).toContain("[Earlier summary]");
  });

  it("clips the middle of a long text and keeps both ends", () => {
    expect(clip("short", 10)).toBe("short");
    const clipped = clip(`${"a".repeat(60)}${"b".repeat(60)}`, 20);
    expect(clipped.startsWith("a".repeat(12))).toBe(true);
    expect(clipped.endsWith("b".repeat(8))).toBe(true);
    expect(clipped).toContain("100 characters left out");
  });

  it("keeps every URL, including ones only a tool result held", () => {
    const ledger = urlLedger(thread);
    expect(ledger).toEqual([
      "https://youtu.be/S6l3aRsecuE",
      "https://mosiah.org/articles/everybodys-building-the-same-agent/",
      "https://example.com/source-only-in-a-result",
    ]);
    expect(withLedger("cites https://youtu.be/S6l3aRsecuE", ledger)).toContain(
      "## Other links from the conversation\n- https://mosiah.org/articles/everybodys-building-the-same-agent/\n- https://example.com/source-only-in-a-result",
    );
    expect(withLedger("all here", [])).toBe("all here");
  });

  it("asks for the person's language without assuming English", () => {
    expect(summaryInstructions(undefined, false)).toContain("the language the person writes in");
    expect(summaryInstructions(undefined, false)).not.toMatch(/English/);
    expect(summaryInstructions("French", true)).toContain("Write the summary in French");
    expect(summaryInstructions(undefined, true)).toContain("earlier summary");
  });

  it("tells the writing systems apart", () => {
    expect(dominantScript("Hello there")).toBe("latin");
    expect(dominantScript("## 目标 用户正在")).toBe("cjk");
    expect(dominantScript("Привет мир")).toBe("cyrillic");
    expect(dominantScript("مرحبا")).toBe("arabic");
    expect(dominantScript("Γειά σου")).toBe("other");
    expect(dominantScript("123 !!")).toBeUndefined();
    expect(matchesPersonsScript("## 目标 用户正在利用", "Notice they never say social")).toBe(false);
    expect(matchesPersonsScript("## Goal", "Notice they never say social")).toBe(true);
    expect(matchesPersonsScript("anything", "123")).toBe(true);
  });

  it("writes the summary with the model and completes the ledger", async () => {
    const prompts: string[] = [];
    const { summary, fallback } = await writeSummary(
      thread,
      async ({ prompt }) => {
        prompts.push(prompt);
        return `## What the person is working on\n${"Reviewing a podcast. ".repeat(12)}https://youtu.be/S6l3aRsecuE`;
      },
      { instructions: "Keep the quotes." },
    );
    expect(fallback).toBe(false);
    expect(prompts[0]).toContain("<conversation>");
    expect(prompts[0]).toContain("Also: Keep the quotes.");
    expect(summary).toContain("- https://example.com/source-only-in-a-result");
  });

  it("asks again when the summary is in another language, then falls back", async () => {
    const attempts: number[] = [];
    const chinese = "## 目标\n".concat("用户正在利用一名助手。".repeat(30));
    const second = await writeSummary(thread, async ({ attempt, prompt }) => {
      attempts.push(attempt);
      if (attempt === 2) expect(prompt).toContain("not in the language the person writes in");
      return attempt === 1 ? chinese : `## What the person is working on\n${"English. ".repeat(40)}`;
    });
    expect(attempts).toEqual([1, 2]);
    expect(second.fallback).toBe(false);

    const failed = await writeSummary(thread, async () => chinese);
    expect(failed.fallback).toBe(true);
    expect(failed.summary).toContain("## What the person said");
  });

  it("falls back when the model fails or answers too little", async () => {
    const thrown = await writeSummary(thread, async () => {
      throw new Error("chunk timeout");
    });
    expect(thrown.fallback).toBe(true);
    const short = await writeSummary(thread, async () => "ok");
    expect(short.fallback).toBe(true);
  });

  it("builds a summary without a model that loses nothing the person said", () => {
    const text = fallbackSummary([earlierSummary("Earlier goals."), ...thread]);
    expect(text).toContain("could not be written");
    expect(text).toContain("## Earlier summary\n<summary>\nEarlier goals.");
    expect(text).toContain("- Review this podcast for delusion");
    expect(text).toContain("- Notice they never say the word social.");
    expect(text).toContain("## The assistant's last answer\nHere is my review.");
    expect(text).toContain("- https://example.com/source-only-in-a-result");
  });

  it("keeps the newest messages when they do not all fit", () => {
    const many = Array.from({ length: 10 }, (_, index) => user(`${index} ${"x".repeat(15_000)}`));
    const text = fallbackSummary(many);
    expect(text).toContain("earlier messages left out");
    expect(text).toContain("- 9 ");
    expect(text).not.toContain("- 0 ");
    expect(fallbackSummary([])).not.toContain("## What the person said");
  });
});
