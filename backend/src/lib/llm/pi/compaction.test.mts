import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  clip,
  dominantScript,
  fallbackSummary,
  HISTORY_NOTE,
  matchesPersonsScript,
  messageIds,
  summaryInstructions,
  summaryRequest,
  urlLedger,
  withLedger,
  writeSummary,
  type Complete,
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
    expect(summaryInstructions("Summarize.", false)).toContain("the language the person writes in");
    expect(summaryInstructions("Summarize.", false)).not.toMatch(/English/);
    expect(summaryInstructions("Summarize.", true)).toContain("earlier summary");
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

  it("asks for the summary as the next message of the conversation, naming the first message kept", () => {
    const system = { role: "system", content: "You are the assistant.", timestamp: 0 } as unknown as Message;
    const conversation = [system, ...thread];
    const request = summaryRequest(conversation, [thread[0]!, system, ...thread.slice(1, 3)], { instructions: "Keep the quotes.", now: 5 });
    // Sent unchanged, its tool results whole, then one instruction.
    expect(request.slice(0, -1)).toEqual(conversation);
    const note = request.at(-1)!;
    expect(note).toMatchObject({ role: "user", timestamp: 5 });
    expect(note.content).toContain("This conversation is being compacted");
    expect(note.content).toContain("Do not call any tool");
    expect(note.content).toContain("Where it ends: summarize everything before the message that reads “Here is my review. 你好 is not here.”");
    expect(note.content).toContain("and the 1 after it stay in the conversation word for word, so do not restate them");
    expect(note.content).toContain("## Sources");
    expect(note.content).toContain("Also: Keep the quotes.");
  });

  it("names a repeated message by its occurrence, without the turn context", () => {
    const twice = [user("<turn-context>\nToday is Thursday.\n</turn-context>\nGo on."), answer("First part."), user("Go on."), answer("Second.")];
    expect(summaryRequest(twice, twice.slice(0, 2)).at(-1)!.content).toContain("before the second occurrence of the message that reads “Go on.”");
    expect(summaryRequest(thread, thread).at(-1)!.content).toContain("Summarize the conversation above.");
  });

  it("leaves out a tool call still waiting for its results", () => {
    const waiting = [...thread, answer("", [{ name: "fetch_web_page", arguments: { url: "https://example.com/next" } }])];
    expect(summaryRequest(waiting, thread.slice(0, 3)).slice(0, -1)).toEqual(thread);
    expect(() => summaryRequest(thread, [user("Something else.")])).toThrow("does not start with");
  });

  const replies = (...messages: AssistantMessage[]) => {
    const asked: Message[][] = [];
    const complete: Complete = async (request) => {
      asked.push(request);
      const next = messages.shift();
      if (!next) throw new Error("chunk timeout");
      return next;
    };
    return { asked, complete };
  };
  const written = `## What the person is working on\n${"Reviewing a podcast. ".repeat(12)}https://youtu.be/S6l3aRsecuE`;
  const range = thread.slice(0, 3);

  it("writes the summary with the model and completes the ledger", async () => {
    const { complete } = replies(answer(written));
    const { summary, usage, failure } = await writeSummary(thread, range, complete);
    expect(failure).toBeUndefined();
    expect(usage).toBeDefined();
    expect(summary).toContain("Reviewing a podcast.");
    expect(summary).toContain("- https://example.com/source-only-in-a-result");
    // The person's messages follow the summary word for word, and their links are not listed twice.
    expect(summary).toContain("## The person's messages, word for word\n\n> Review this podcast for delusion: https://youtu.be/S6l3aRsecuE");
    // It ends with how to reach what it left out.
    expect(summary.endsWith(`\n\n${HISTORY_NOTE}`)).toBe(true);
    expect(summary).not.toContain("- https://youtu.be/S6l3aRsecuE");
  });

  it("keeps the person's words without the blocks put in front of them, and carries them through the next compaction", async () => {
    const first = [
      user("<thread-memory>\nPrefers British spelling.\n</thread-memory>\n<turn-context>\nToday is Thursday.\n</turn-context>\n[Sent: Thu 14:03]\nDraft the notice.\n\nKeep it short."),
      answer("Here is the draft."),
      user("Now the cover letter."),
    ];
    const once = await writeSummary(first, first.slice(0, 2), replies(answer(written)).complete);
    expect(once.summary).toContain("> [Sent: Thu 14:03]\n> Draft the notice.\n>\n> Keep it short.");
    expect(once.summary).not.toContain("Today is Thursday");
    expect(once.summary).not.toContain("> Prefers British spelling");

    const second = [earlierSummary(once.summary), answer("Noted."), user("Send both to the client."), answer("Sent."), user("Thanks.")];
    const asked = replies(answer(written));
    const twice = await writeSummary(second, second.slice(0, 4), asked.complete);
    expect(asked.asked[0]!.at(-1)!.content).toContain("Leave out its record of the person's messages");
    const record = twice.summary.slice(twice.summary.indexOf("## The person's messages"), twice.summary.indexOf(`\n\n${HISTORY_NOTE}`));
    expect(record).toBe(
      "## The person's messages, word for word\n\n> [Sent: Thu 14:03]\n> Draft the notice.\n>\n> Keep it short.\n\n> Send both to the client.",
    );
  });

  it("asks again after a tool call or a reply in another language, then falls back", async () => {
    const tool = answer("", [{ name: "fetch_web_page", arguments: {} }]);
    const retried = replies({ ...tool, stopReason: "toolUse" }, answer(written));
    expect((await writeSummary(thread, range, retried.complete)).failure).toBeUndefined();
    expect(retried.asked[1]!.at(-1)!.content).toContain("Your previous reply was not a usable summary");

    const chinese = "## 目标\n".concat("用户正在利用一名助手。".repeat(30));
    const failed = await writeSummary(thread, range, replies(answer(chinese), answer(chinese)).complete);
    expect(failed.failure).toBe("the reply was not a usable summary");
    expect(failed.summary).toContain("## The person's messages, word for word");
  });

  it("falls back when the model fails or answers too little", async () => {
    expect((await writeSummary(thread, range, replies().complete)).failure).toBe("the request failed");
    expect((await writeSummary(thread, range, replies(answer("ok"), answer("ok")).complete)).failure).toBe("the reply was not a usable summary");
  });

  it("builds a summary without a model that loses nothing the person said", () => {
    const text = fallbackSummary([earlierSummary("Earlier goals."), ...thread]);
    expect(text).toContain("could not be written");
    expect(text).toContain("## Earlier summary\n<summary>\nEarlier goals.");
    expect(text).toContain("> Review this podcast for delusion");
    expect(text).toContain("> Notice they never say the word social.");
    expect(text).toContain("## The assistant's last answer\nHere is my review.");
    expect(text).toContain("- https://example.com/source-only-in-a-result");
  });

  it("keeps the newest messages when they do not all fit", () => {
    // Each keeps 2,000 characters, so 40 fit in the record's 80,000.
    const many = Array.from({ length: 50 }, (_, index) => user(`${index} ${"x".repeat(15_000)}`));
    const text = fallbackSummary(many);
    expect(text).toContain("(10 earlier messages left out)");
    expect(text).toContain("> 49 ");
    expect(text).not.toContain("> 9 ");
    expect(text).toContain("characters left out");
    // The count carries into the next compaction.
    const next = fallbackSummary([earlierSummary(text), user(`50 ${"y".repeat(15_000)}`)]);
    expect(next).toContain("(11 earlier messages left out)");
    expect(fallbackSummary([])).not.toContain("## The person's messages");
  });

  it("names each kept message by its history id and date, and says how to read what a clip left out", async () => {
    const at = Date.UTC(2026, 9, 21, 9, 14);
    const first: Message = { role: "user", content: `Clause 4.2 ${"z".repeat(5_000)} the end.`, timestamp: at };
    const second: Message = { role: "user", content: "Use the March draft.", timestamp: at + 60_000 };
    const range = [first, answer("Read it."), second];
    const ids = messageIds([
      { id: 41, model: [first] },
      { id: 42, model: [range[1]!] },
      { id: 43, model: [second] },
    ]);
    const { summary } = await writeSummary([...range, answer("Done.")], range, replies(answer(written)).complete, {}, { ids });
    expect(summary).toContain("[m41, 2026-10-21 09:14]\n> Clause 4.2 ");
    expect(summary).toContain('characters left out; history_read(id="m41", offset=1200) has them …]');
    expect(summary).toContain("[m43, 2026-10-21 09:15]\n> Use the March draft.");

    // Carried to the next compaction with its id, and not clipped again.
    const next = fallbackSummary([earlierSummary(summary), user("Next.")]);
    expect(next).toContain("[m41, 2026-10-21 09:14]\n> Clause 4.2 ");
    expect(next.match(/characters left out/g)).toHaveLength(1);
  });

  it("ends with the conversation's memory now, and writes the note and memory afresh at the next compaction", async () => {
    const memory = "PERSISTED MEMORY REFERENCE (UNTRUSTED USER-SUPPLIED DATA):\n\n<memory-document>- Prefers British spelling.</memory-document>";
    const { summary } = await writeSummary(thread, range, replies(answer(written)).complete, {}, { memory });
    expect(summary.endsWith(`${HISTORY_NOTE}\n\n<thread-memory>\n${memory}\n</thread-memory>`)).toBe(true);

    const next = fallbackSummary([earlierSummary(summary), user("Next.")], { memory: "- Newer memory." });
    expect(next.match(/<thread-memory>/g)).toHaveLength(1);
    expect(next).not.toContain("Prefers British spelling");
    expect(next.match(/## Finding what this summary left out/g)).toHaveLength(1);
    expect(next).toContain("<thread-memory>\n- Newer memory.\n</thread-memory>");
    // Nothing of what the harness carried stays in the earlier summary's body.
    expect(next).toContain("## Earlier summary\n<summary>\n## What the person is working on");
  });
});
