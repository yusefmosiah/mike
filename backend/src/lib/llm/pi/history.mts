// The conversation's own history, searchable and readable from code mode
// (`tools.history_search`, `tools.history_read`): what a compaction summary
// left out is still stored, entry by entry, and the model can look it up
// instead of guessing or asking the person to paste it again.
//
// Every message the conversation ever had on its active branch is an item,
// named by its Pi entry (`m41`; a second message in the same entry is
// `m41.2`), so a summary can cite an item and the model can read it back.
// Items the current context no longer holds are marked compacted.

import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { withoutThreadMemory, withoutTurnContext } from "../turnContext.js";

export type HistoryRole = "user" | "assistant" | "tool";

export type HistoryItem = {
  id: string;
  role: HistoryRole;
  /** When the message was written, as Pi recorded it. */
  at?: number;
  text: string;
  /** The current context holds only a summary of it. */
  compacted: boolean;
};

/** How pi-durable introduces a compaction summary in the transcript. */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";
// Mike stamps a user message with its send time; `at` carries that instead.
const STAMP = /^\[(?:Sent|Answered): [^\]\n]*\]\n/;

const SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const SNIPPET_CHARS = 200;
const MAX_SNIPPET_CHARS = 2_000;
const READ_CHARS = 8_000;
const MAX_READ_CHARS = 40_000;
const MAX_PATTERN_CHARS = 500;

/** The name a summary and the history functions use for an entry. */
export function historyId(entry: number, index = 0): string {
  return index === 0 ? `m${entry}` : `m${entry}.${index + 1}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[image]" : ""))
    .join("\n");
}

function messageText(message: Message): { role: HistoryRole; text: string } | null {
  if (message.role === "user") {
    const text = contentText(message.content);
    // Compaction summaries and Mike's own notes to the model are not the conversation.
    if (text.startsWith(SUMMARY_PREFIX) || text.startsWith("<harness>")) return null;
    const said = withoutTurnContext(withoutThreadMemory(text.trim())).replace(STAMP, "").trim();
    return said ? { role: "user", text: said } : null;
  }
  if (message.role === "assistant") {
    const parts = message.content.flatMap((part) =>
      part.type === "text" && part.text.trim()
        ? [part.text.trim()]
        : part.type === "toolCall"
          ? [`[called ${part.name} ${JSON.stringify(part.arguments)}]`]
          : [],
    );
    return parts.length ? { role: "assistant", text: parts.join("\n") } : null;
  }
  if (message.role === "toolResult") {
    return { role: "tool", text: `[result of ${message.toolName}]\n${contentText(message.content)}` };
  }
  return null;
}

/** The conversation's items, oldest first, from its fork-aware entries and the entries its context still holds. */
export function historyItems(entries: readonly EntryRecord[], inContext: ReadonlySet<number>): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    (entry.model ?? []).forEach((message, index) => {
      const shown = messageText(message);
      if (!shown) return;
      items.push({
        id: historyId(entry.id as number, index),
        ...shown,
        ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}),
        compacted: !inContext.has(entry.id as number),
      });
    });
  }
  return items;
}

type Reply = { content: string; isError: boolean };
const refuse = (error: string): Reply => ({ content: error, isError: true });

function bounded(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
}

function dated(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** Item ids compare by entry, then by position in it. */
function order(id: string): [number, number] {
  const match = /^m(\d+)(?:\.(\d+))?$/.exec(id.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 1)] : [NaN, NaN];
}

function before(a: string, b: string): boolean {
  const [ea, ia] = order(a);
  const [eb, ib] = order(b);
  return ea < eb || (ea === eb && ia < ib);
}

/**
 * `history_search`: the newest items first whose text matches `query`
 * (words, matched case-insensitively, or a regular expression with
 * `regex: true`), each with a snippet around its first match.
 */
export function searchHistory(items: readonly HistoryItem[], input: Record<string, unknown>): Reply {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return refuse("Give a query: words or a pattern to find.");
  if (query.length > MAX_PATTERN_CHARS) return refuse(`The query is too long (the limit is ${MAX_PATTERN_CHARS} characters).`);
  let pattern: RegExp;
  try {
    pattern = input.regex === true
      ? new RegExp(query, "gi")
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
  } catch {
    return refuse("The pattern is not a valid regular expression.");
  }
  const roles = Array.isArray(input.roles)
    ? new Set(input.roles.filter((role): role is string => typeof role === "string"))
    : typeof input.role === "string"
      ? new Set([input.role])
      : undefined;
  const compactedOnly = input.compacted_only === true;
  const beforeId = typeof input.before === "string" ? input.before : undefined;
  const limit = Math.max(1, bounded(input.limit, SEARCH_LIMIT, MAX_SEARCH_LIMIT));
  const around = bounded(input.context_chars, SNIPPET_CHARS, MAX_SNIPPET_CHARS);

  const matches: Record<string, unknown>[] = [];
  let total = 0;
  let next: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (roles && !roles.has(item.role)) continue;
    if (compactedOnly && !item.compacted) continue;
    if (beforeId && !before(item.id, beforeId)) continue;
    pattern.lastIndex = 0;
    const found = [...item.text.matchAll(pattern)];
    if (found.length === 0) continue;
    total += 1;
    if (matches.length === limit) {
      next ??= matches.at(-1)!.id as string;
      continue;
    }
    const first = found[0]!;
    const start = Math.max(0, first.index - around);
    const end = Math.min(item.text.length, first.index + first[0].length + around);
    matches.push({
      id: item.id,
      role: item.role,
      ...(dated(item.at) ? { at: dated(item.at) } : {}),
      compacted: item.compacted,
      hits: found.length,
      offset: first.index,
      snippet: `${start > 0 ? "…" : ""}${item.text.slice(start, end)}${end < item.text.length ? "…" : ""}`,
      length: item.text.length,
    });
  }
  return {
    content: JSON.stringify({
      matches,
      total,
      ...(next ? { more: `${total - matches.length} more; pass before="${next}" for the next page` } : {}),
    }),
    isError: false,
  };
}

/**
 * `history_read`: one item's text from `offset`, up to `limit_chars`, or the
 * items from `id` through `through`, in order, within the same budget.
 */
export function readHistory(items: readonly HistoryItem[], input: Record<string, unknown>): Reply {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return refuse(`No message "${id}" in this conversation. Ids look like m41; history_search gives them.`);
  const limit = Math.max(1, bounded(input.limit_chars, READ_CHARS, MAX_READ_CHARS));
  const through = typeof input.through === "string" ? input.through.trim() : "";
  if (through) {
    const last = items.findIndex((item) => item.id === through);
    if (last < at) return refuse(`No message "${through}" at or after "${id}".`);
    const shown: Record<string, unknown>[] = [];
    let budget = limit;
    let index = at;
    for (; index <= last && budget > 0; index += 1) {
      const item = items[index]!;
      const text = item.text.slice(0, budget);
      budget -= text.length;
      shown.push({
        id: item.id,
        role: item.role,
        ...(dated(item.at) ? { at: dated(item.at) } : {}),
        compacted: item.compacted,
        text,
        ...(text.length < item.text.length ? { more: `read the rest with history_read(id="${item.id}", offset=${text.length})` } : {}),
      });
    }
    return {
      content: JSON.stringify({
        messages: shown,
        ...(index <= last ? { more: `continue with history_read(id="${items[index]!.id}", through="${through}")` } : {}),
      }),
      isError: false,
    };
  }
  const item = items[at]!;
  const offset = Math.min(bounded(input.offset, 0, Number.MAX_SAFE_INTEGER), item.text.length);
  const text = item.text.slice(offset, offset + limit);
  const end = offset + text.length;
  return {
    content: JSON.stringify({
      id: item.id,
      role: item.role,
      ...(dated(item.at) ? { at: dated(item.at) } : {}),
      compacted: item.compacted,
      offset,
      length: item.text.length,
      text,
      ...(end < item.text.length ? { more: `continue with history_read(id="${item.id}", offset=${end})` } : {}),
    }),
    isError: false,
  };
}
