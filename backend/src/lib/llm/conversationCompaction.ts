import type { ModelMessage } from "ai" with { "resolution-mode": "import" };
import type { CompactTurn } from "../compaction/policy";
import { compactIfNeeded } from "../compaction";
import {
  contextWindowForModel,
  estimateTokens,
  KEEP_RECENT_TOKENS,
  MEDIA_TOKENS,
  RECOVERY_BAND,
  resolveThresholdTokens,
  clampThresholdPercent,
  shouldCompact,
  splitRecentTurns,
} from "../compaction/policy";
import { summarizeToText } from "../compaction/textFallback";
import type { OpenAIToolSchema } from "./types";

export type ModelCompactionArgs = {
  messages: readonly ModelMessage[];
  modelId: string;
  systemPrompt: string;
  tools?: readonly OpenAIToolSchema[];
  contextTokens?: number;
  force?: boolean;
  thresholdPct?: number;
};

type Unit = {
  messages: ModelMessage[];
  role: string;
  text: string;
  pending: boolean;
  tokens: number;
};

// Omission notice, excerpt headings and provider serialization slack.
const RESULT_SUMMARY_OVERHEAD_TOKENS = 256;

// Summarize text and serialized tool inputs/results, not transport bytes or
// provider cache hints. Retained messages themselves are never reconstructed.
function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "reasoning") return part.text;
    if (part.type === "file" || part.type === "image") return "[Attached media]";
    return JSON.stringify(part);
  }).join("\n");
}

function unitsFor(messages: readonly ModelMessage[]): Unit[] {
  const units: Unit[] = [];
  for (const message of messages) {
    const text = messageText(message);
    const previous = units[units.length - 1];
    if (message.role === "tool" && previous?.role === "assistant") {
      previous.messages.push(message);
      previous.text += `\n[tool]\n${text}`;
    } else {
      units.push({ messages: [message], role: message.role, text, pending: false, tokens: 0 });
    }
  }
  for (const unit of units) {
    const outstanding = new Set<string>();
    let mediaTokens = 0;
    for (const message of unit.messages) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type === "file" || part.type === "image") mediaTokens += MEDIA_TOKENS;
        if (part.type === "tool-call") outstanding.add(part.toolCallId);
        if (part.type === "tool-result") outstanding.delete(part.toolCallId);
      }
    }
    unit.pending = outstanding.size > 0;
    unit.tokens = estimateTokens(unit.text) + mediaTokens;
  }
  return units;
}

function overhead(args: ModelCompactionArgs): number {
  return estimateTokens(args.systemPrompt) + estimateTokens(JSON.stringify(args.tools ?? []));
}

/**
 * A completed tool result can itself overflow the window. Reduce its output,
 * not its call identity or arguments, and explicitly tell the model what was
 * omitted. Ordinary retained results remain byte-identical.
 */
function reduceNewestToolResult(units: Unit[], availableTokens: number): boolean {
  const newest = units.at(-1);
  if (!newest || newest.pending || newest.tokens <= availableTokens) return false;
  let resultCount = 0;
  let mandatoryTokens = 0;
  for (const message of newest.messages) {
    // Reserve unchanged calls, result identities, media and message overhead
    // before dividing the remaining space among result bodies.
    mandatoryTokens += 8;
    if (message.role !== "tool") {
      mandatoryTokens += estimateTokens(messageText(message));
      if (typeof message.content !== "string") {
        for (const part of message.content) {
          if (part.type === "file" || part.type === "image") mandatoryTokens += MEDIA_TOKENS;
        }
      }
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result") {
        resultCount++;
        mandatoryTokens += estimateTokens(JSON.stringify({
          ...part,
          output: { type: "text", value: "" },
        }));
      } else {
        mandatoryTokens += estimateTokens(JSON.stringify(part));
      }
    }
  }
  if (resultCount === 0) return false;
  const outputTokens = Math.min(
    KEEP_RECENT_TOKENS / 2,
    availableTokens - mandatoryTokens - resultCount * RESULT_SUMMARY_OVERHEAD_TOKENS,
  );
  const budget = Math.floor(outputTokens / resultCount);
  if (budget < 256) return false;
  let changed = false;
  const messages = newest.messages.map((message): ModelMessage => {
    if (message.role !== "tool") return message;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output.type === "text" || part.output.type === "error-text"
        ? part.output.value
        : JSON.stringify(part.output);
      if (estimateTokens(output) <= budget) return part;
      changed = true;
      const anchorBudget = Math.floor(budget / 2);
      const anchors = summarizeToText([{ role: "tool", text: output }], anchorBudget);
      const tail = output.slice(-Math.max(0, (budget - anchorBudget) * 4 - 256));
      // Bound the encoded value, not just its plain characters: quotes and
      // backslashes in legal/JSON output otherwise consume unreserved space.
      const render = (chars: number) =>
        `[Context compacted: oversized tool result; full output omitted. Use a targeted or paginated read if details are missing.]\n${anchors.slice(0, chars)}\nFINAL EXCERPT\n${chars > 0 ? tail.slice(-chars) : ""}`;
      let chars = Math.max(anchors.length, tail.length);
      if (JSON.stringify(render(chars)).length > budget * 4) {
        let low = 0;
        let high = chars;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (JSON.stringify(render(mid)).length <= budget * 4) low = mid;
          else high = mid - 1;
        }
        chars = low;
      }
      return {
        ...part,
        output: {
          type: part.output.type === "error-text" || part.output.type === "error-json"
            ? "error-text" as const
            : "text" as const,
          value: render(chars),
        },
      };
    });
    return content.every((part, index) => part === message.content[index])
      ? message
      : { ...message, content };
  });
  if (changed) units[units.length - 1] = unitsFor(messages)[0];
  return changed;
}

export function compactModelMessages(args: ModelCompactionArgs): {
  compacted: boolean;
  messages: ModelMessage[];
} {
  const unchanged = { compacted: false, messages: args.messages as ModelMessage[] };
  const window = contextWindowForModel(args.modelId);
  if (!window) return unchanged;
  const fixed = overhead(args);
  const threshold = resolveThresholdTokens(window, clampThresholdPercent(args.thresholdPct));
  if (fixed >= Math.floor(threshold * RECOVERY_BAND)) return unchanged;
  const units = unitsFor(args.messages);
  const estimated = fixed + units.reduce((sum, unit) => sum + unit.tokens, 0);
  const reported = Number.isFinite(args.contextTokens) ? Math.max(0, args.contextTokens ?? 0) : 0;
  const before = Math.max(estimated, reported);
  if (!args.force && !shouldCompact(before, window, clampThresholdPercent(args.thresholdPct))) return unchanged;
  let latestUser = -1;
  for (let index = units.length - 1; index >= 0; index--) {
    if (units[index].role !== "user") continue;
    latestUser = index;
    break;
  }
  const activeRequestTokens = latestUser >= 0 ? units[latestUser].tokens : 0;
  const availableTokens = Math.floor(threshold * RECOVERY_BAND) - fixed - activeRequestTokens;
  if (availableTokens <= 0) return unchanged;
  const newest = units.at(-1);
  let budget = args.force ? Math.min(availableTokens, KEEP_RECENT_TOKENS) : availableTokens;
  let reducedToolOutput = false;
  let turns: CompactTurn[];
  for (;;) {
    // Rebuild from the original result; repeated budgeting must not summarize
    // an already summarized value or lose its final excerpt.
    if (newest) units[units.length - 1] = newest;
    reducedToolOutput = reduceNewestToolResult(units, budget);
    turns = units.map(({ role, text, tokens }) => ({
      role,
      text,
      additionalTokens: tokens - estimateTokens(text),
    }));
    const tailStart = units.length - splitRecentTurns(turns).kept.length;
    let otherRetainedTokens = fixed;
    let discardsHistory = false;
    for (let index = 0; index < units.length - 1; index++) {
      const unit = units[index];
      if (index >= tailStart || index === latestUser || unit.pending) {
        otherRetainedTokens += unit.tokens;
      } else {
        discardsHistory = true;
      }
    }
    // Shrinking the newest unit can admit preceding units into the tail.
    // Repartition until its budget stops decreasing, reserving a meaningful
    // summary plus its envelope whenever older history will be discarded.
    const nextBudget = Math.min(budget,
      Math.floor(threshold * RECOVERY_BAND) - otherRetainedTokens - (discardsHistory ? 520 : 0));
    if (nextBudget >= budget) break;
    if (nextBudget <= 0) return unchanged;
    budget = nextBudget;
  }
  const result = compactIfNeeded({
    turns,
    modelId: args.modelId,
    contextTokens: args.force ? Math.max(before, threshold + 1) : before,
    thresholdPct: args.thresholdPct,
    reservedTokens: fixed,
    protectedTurnIndices: units.flatMap((unit, index) =>
      index === latestUser || unit.pending ? [index] : []),
  });
  if (!result.compacted || !result.summaryText) {
    const projected = fixed + units.reduce((sum, unit) => sum + unit.tokens, 0);
    if (!reducedToolOutput || projected >= before || projected > Math.floor(threshold * RECOVERY_BAND)) return unchanged;
    return { compacted: true, messages: units.flatMap((unit) => unit.messages) };
  }
  const keptTurns = new Set(result.keptTurns);
  const retained = units.filter((_, index) => keptTurns.has(turns[index]));

  const frames = result.archivedFrames;
  const summary: ModelMessage = frames?.length
    ? { role: "user", content: [
        { type: "text", text: result.summaryText },
        ...frames.map((frame) => ({ type: "file" as const, data: frame.image, mediaType: frame.mimeType })),
      ] }
    : { role: "user", content: result.summaryText };
  // A conservative image allowance plus text overhead must still leave the
  // recovery band; provider usage remains authoritative on subsequent steps.
  const projected = fixed + 8 + estimateTokens(result.summaryText)
    + retained.reduce((sum, unit) => sum + unit.tokens, 0)
    + (frames?.length ?? 0) * MEDIA_TOKENS;
  if (projected >= before || projected > Math.floor(threshold * RECOVERY_BAND)) return unchanged;
  return { compacted: true, messages: [summary, ...retained.flatMap((unit) => unit.messages)] };
}

/**
 * Reconstruct historical checkpoints in send order. Replaying the same full
 * transcript plus a new turn preserves the previous compacted prefix without
 * a mutable cache, branch collisions, or deleting the visible transcript.
 */
export function replayConversationCompaction(args: ModelCompactionArgs): {
  compacted: boolean;
  messages: ModelMessage[];
} {
  const window = contextWindowForModel(args.modelId);
  if (!window) return { compacted: false, messages: args.messages as ModelMessage[] };
  const fixed = overhead(args);
  const recoveryCeiling = Math.floor(resolveThresholdTokens(window, clampThresholdPercent(args.thresholdPct)) * RECOVERY_BAND);
  if (fixed >= recoveryCeiling) return { compacted: false, messages: args.messages as ModelMessage[] };
  let activeRequestTokens = 0;
  let tokens = fixed;
  let messages: ModelMessage[] = [];
  let compacted = false;
  for (const unit of unitsFor(args.messages)) {
    messages.push(...unit.messages);
    tokens += unit.tokens;
    if (unit.role === "user") activeRequestTokens = unit.tokens;
    // The active request cannot be summarized. Don't repeatedly rescan an
    // impossible prefix while it remains the current request.
    if (fixed + activeRequestTokens > recoveryCeiling) continue;
    if (fixed + unit.tokens > recoveryCeiling && !unit.messages.some((message) => message.role === "tool")) continue;
    if (!shouldCompact(tokens, window, clampThresholdPercent(args.thresholdPct))) continue;
    const result = compactModelMessages({ ...args, messages, contextTokens: tokens, force: false });
    if (!result.compacted) continue;
    compacted = true;
    messages = result.messages;
    tokens = fixed + unitsFor(messages).reduce((sum, item) => sum + item.tokens, 0);
  }
  return { compacted, messages: compacted ? messages : args.messages as ModelMessage[] };
}
