// Mike's compaction: what replaces the older part of a long chat once it no
// longer fits (or passes the owner's auto-compact threshold).
//
// pi-durable's built-in summarizer is written for coding sessions: it keeps
// "file paths, function names, error messages", cuts tool results to 2,000
// characters, gives the summarizer no language and too small an answer budget
// for a model that thinks. On long research and writing threads it lost every
// URL, failed on half its runs, and once wrote the whole summary in Chinese.
//
// This summary is built for the work Mike's chats do: it keeps the person's own
// positions in their words, the sources with their URLs, verbatim quotes, the
// documents and drafts, and every open request; it is written in the language
// the person writes in; and anything it drops that can be checked mechanically
// (URLs) is carried over in a ledger. When the model fails, a summary built
// without a model takes its place, so a compaction never fails the turn.

import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

/** How pi-durable introduces a summary in the transcript; a previous summary is folded into the next. */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

/** Per-message caps of the summarizer's source: generous, but a pasted book should not fill the request. */
const USER_MAX_CHARS = 16_000;
const ASSISTANT_MAX_CHARS = 8_000;
const TOOL_CALL_MAX_CHARS = 800;
const TOOL_RESULT_MAX_CHARS = 3_000;
/** The fallback keeps every user message up to this much text in all. */
const FALLBACK_USER_BUDGET = 60_000;

export const SUMMARY_SYSTEM_PROMPT = `You write the working memory of a long conversation between a person and their assistant. The older part of the conversation is about to be removed from the assistant's view; your summary is all the assistant will keep of it. Do not continue the conversation and do not answer anything in it: output only the summary.`;

export function summaryInstructions(language: string | undefined, earlierSummary: boolean): string {
  return [
    earlierSummary
      ? "The conversation starts with an earlier summary. Keep everything in it that is still true, and fold the newer messages into it; do not drop older sources, quotes or open requests."
      : "Summarize the conversation above.",
    "",
    "Use these sections, in this order. Leave a section out only when it would be empty.",
    "",
    "## What the person is working on",
    "Their goals and the current task, in a few lines.",
    "",
    "## The person's own positions",
    "Their arguments, theses and corrections, each as a bullet that quotes their own words where they were distinctive. Their views are the point of the work: never soften or merge them into yours.",
    "",
    "## Preferences and instructions",
    "How they want the work done: language, tone, format, what to avoid, standing instructions, corrections they made to the assistant.",
    "",
    "## Sources",
    "Every source used: title or description, the full URL or document name exactly as it appeared, and what it was used for. Never shorten a URL.",
    "",
    "## Quotes",
    "Verbatim quotes that matter to the work, with who said them and the source (and timestamp or location when known). Copy them exactly, in their original language.",
    "",
    "## Documents and files",
    "Drafts, documents and files created or edited, with their names, ids or paths, and the state each is in.",
    "",
    "## Decisions and findings",
    "What was settled or found, and why.",
    "",
    "## Open requests and next steps",
    "Everything the person asked for that is not done yet, quoting their request, and the next steps.",
    "",
    language
      ? `Write the summary in ${language}, the language the person writes in, whatever language the sources or earlier replies used. Keep quotes in their original language.`
      : "Write the summary in the language the person writes in (judge by their own messages, not by sources, quotes or earlier replies). Keep quotes in their original language.",
    "Be complete rather than brief: this summary replaces the conversation.",
  ].join("\n");
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;

function textOf(content: UserMessage["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

/** Keep the head and the tail of a long text: a long paste's end is often what was asked about. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(text.length - tail)}`;
}

function isSummary(message: Message): boolean {
  return message.role === "user" && textOf(message.content).startsWith(SUMMARY_PREFIX);
}

/** The summarizer's source: the transcript as text, with an earlier summary kept whole. */
export function serializeForSummary(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user" && isSummary(message)) {
      parts.push(`[Earlier summary]\n${textOf(message.content)}`);
    } else if (message.role === "user") {
      parts.push(`[Person]\n${clip(textOf(message.content), USER_MAX_CHARS)}`);
    } else if (message.role === "assistant") {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (text) parts.push(`[Assistant]\n${clip(text, ASSISTANT_MAX_CHARS)}`);
      for (const part of message.content) {
        if (part.type === "toolCall") {
          parts.push(`[Assistant used ${part.name}]\n${clip(JSON.stringify(part.arguments), TOOL_CALL_MAX_CHARS)}`);
        }
      }
    } else if (message.role === "toolResult") {
      parts.push(
        `[${message.toolName} ${message.isError ? "failed" : "returned"}]\n${clip(textOf(message.content), TOOL_RESULT_MAX_CHARS)}`,
      );
    }
  }
  return parts.join("\n\n");
}

/** Every URL in the range, in order of first appearance, including ones only a tool result held. */
export function urlLedger(messages: readonly Message[]): string[] {
  const seen = new Set<string>();
  const add = (text: string) => {
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      seen.add(url);
    }
  };
  for (const message of messages) {
    if (message.role === "user" || message.role === "toolResult") add(textOf(message.content));
    else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") add(part.text);
        else if (part.type === "toolCall") add(JSON.stringify(part.arguments));
      }
    }
  }
  return [...seen];
}

/** URLs the summary dropped, carried over as a ledger so a source is never lost to compaction. */
export function withLedger(summary: string, ledger: readonly string[]): string {
  const missing = ledger.filter((url) => !summary.includes(url));
  if (missing.length === 0) return summary;
  return `${summary.trimEnd()}\n\n## Other links from the conversation\n${missing.map((url) => `- ${url}`).join("\n")}`;
}

/** The writing systems text uses, for telling a summary in the wrong language from the right one. */
export type Script = "latin" | "cjk" | "cyrillic" | "arabic" | "other";

export function scriptOf(char: string): Script | undefined {
  const code = char.codePointAt(0) ?? 0;
  if (/\p{Script=Latin}/u.test(char)) return "latin";
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) return "cjk";
  if (/\p{Script=Cyrillic}/u.test(char)) return "cyrillic";
  if (/\p{Script=Arabic}/u.test(char)) return "arabic";
  return code > 0x2ff && /\p{L}/u.test(char) ? "other" : undefined;
}

/** The script most of `text`'s letters are in. */
export function dominantScript(text: string): Script | undefined {
  const counts = new Map<Script, number>();
  for (const char of text) {
    const script = scriptOf(char);
    if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  let best: Script | undefined;
  let most = 0;
  for (const [script, count] of counts) {
    if (count > most) {
      best = script;
      most = count;
    }
  }
  return best;
}

/** The person's own words in the range: what the summary's language should follow. */
export function personsText(messages: readonly Message[]): string {
  return messages
    .filter((message): message is UserMessage => message.role === "user" && !isSummary(message))
    .map((message) => textOf(message.content))
    .join("\n");
}

/** Whether a summary is in the same writing system as the person's messages. */
export function matchesPersonsScript(summary: string, person: string): boolean {
  const want = dominantScript(person);
  if (!want) return true;
  return dominantScript(summary) === want;
}

/**
 * The summary built without a model: the earlier summary, every one of the
 * person's messages (newest kept first when they do not all fit), the last
 * answer and the URL ledger. Worse than a written summary, but nothing the
 * person said is lost to a failed model call.
 */
export function fallbackSummary(messages: readonly Message[]): string {
  const sections: string[] = [
    "(The automatic summary could not be written, so this is an excerpt of the earlier conversation.)",
  ];
  const earlier = messages.filter((message): message is UserMessage => message.role === "user" && isSummary(message)).at(-1);
  if (earlier) sections.push(`## Earlier summary\n${textOf(earlier.content).slice(SUMMARY_PREFIX.length).trim()}`);

  const said = messages
    .filter((message): message is UserMessage => message.role === "user" && !isSummary(message))
    .map((message) => textOf(message.content).trim())
    .filter(Boolean);
  const kept: string[] = [];
  let budget = FALLBACK_USER_BUDGET;
  for (let index = said.length - 1; index >= 0 && budget > 0; index -= 1) {
    const text = clip(said[index], Math.min(budget, USER_MAX_CHARS));
    kept.unshift(`- ${text.replace(/\n/g, "\n  ")}`);
    budget -= text.length;
  }
  if (kept.length < said.length) kept.unshift(`- (${said.length - kept.length} earlier messages left out)`);
  if (kept.length) sections.push(`## What the person said\n${kept.join("\n")}`);

  const lastAnswer = [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.trim()),
    );
  if (lastAnswer) {
    const text = lastAnswer.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    sections.push(`## The assistant's last answer\n${clip(text.trim(), ASSISTANT_MAX_CHARS)}`);
  }
  return withLedger(sections.join("\n\n"), urlLedger(messages));
}

/** Writes one summary: a model call that returns the text, or throws. */
export type Summarize = (request: { system: string; prompt: string; attempt: number }) => Promise<string>;

/**
 * The summary of `messages`: written by the model in the person's language,
 * checked, and completed with the URL ledger; the model-free summary when the
 * model fails twice or keeps answering in another writing system.
 */
export async function writeSummary(
  messages: readonly Message[],
  summarize: Summarize,
  options: { language?: string; instructions?: string } = {},
): Promise<{ summary: string; fallback: boolean }> {
  const source = serializeForSummary(messages);
  const person = personsText(messages);
  const ledger = urlLedger(messages);
  const base = summaryInstructions(options.language, messages.some(isSummary));
  const extra = options.instructions?.trim() ? `\n\nAlso: ${options.instructions.trim()}` : "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reminder =
      attempt > 1
        ? "\n\nYour previous summary was not in the language the person writes in. Write it in their language."
        : "";
    let text: string;
    try {
      text = (
        await summarize({
          system: SUMMARY_SYSTEM_PROMPT,
          prompt: `<conversation>\n${source}\n</conversation>\n\n${base}${extra}${reminder}`,
          attempt,
        })
      ).trim();
    } catch {
      continue;
    }
    if (text.length < 200) continue;
    if (!matchesPersonsScript(text, person)) continue;
    return { summary: withLedger(text, ledger), fallback: false };
  }
  return { summary: fallbackSummary(messages), fallback: true };
}

/** The owner's suggestion for million-token models: compact well before the window, at 500k. */
const AUTOCOMPACT_CEILING = 500_000;

/**
 * Where a chat compacts when its owner set nothing for the model: at 500k
 * tokens, or at 80% of a smaller window (pi-durable's own threshold, near the
 * window's end, stays as the backstop).
 */
export function defaultAutocompactTokens(contextWindow: number): number {
  return Math.min(AUTOCOMPACT_CEILING, Math.floor(contextWindow * 0.8));
}

/** The smallest and largest thresholds `/autocompact` accepts. */
export const AUTOCOMPACT_MIN_TOKENS = 20_000;
export const AUTOCOMPACT_MAX_TOKENS = 10_000_000;
