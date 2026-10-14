// Wires Mike's compaction (compaction.mts) into pi-durable: the summary every
// compaction writes, and the owner's auto-compact threshold.

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  type ConversationId,
  type Extension,
  type Harness,
  type HookApi,
} from "@earendil-works/pi-durable";
import { safeError } from "../../safeError.js";
import { defaultAutocompactTokens, writeSummary } from "./compaction.mjs";
import { lightestThinkingLevel } from "./providers.mjs";

/** Room for a summary of a long thread, on top of what a thinking model spends first. */
const SUMMARY_MAX_TOKENS = 24_000;
const SUMMARY_THINKING_HEADROOM = 16_000;

/**
 * The settings Mike opens the Harness with. A 32k reserve leaves a thinking
 * model room to answer at the window's edge, and 30k of recent context stays
 * verbatim. These thresholds near the window's end are the backstop; the
 * owner's auto-compact threshold (below) normally compacts much earlier.
 */
export const COMPACTION_SETTINGS = {
  reserveTokens: 32_768,
  backgroundTokens: 65_536,
  keepRecentTokens: 30_000,
} as const;

/** Each conversation's auto-compact threshold for its current turn, when its owner set one. */
const thresholds = new Map<number, number>();
/** Conversations with an auto-compaction running, so one is not started per response. */
const running = new Set<number>();

export function setAutocompactThreshold(conversation: number, tokens: number | undefined): void {
  if (tokens === undefined) thresholds.delete(conversation);
  else thresholds.set(conversation, tokens);
}

/** The model the summary is written with: the one that last answered in the range. */
function summarizerModel(messages: readonly Message[], api: HookApi) {
  const last = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
  return last ? api.models.getModel(last.provider, last.model) : undefined;
}

/** How much of the window a response's request and answer took. */
export function contextTokens(message: AssistantMessage): number {
  const usage = message.usage;
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

export function compactionExtension(harness: () => Harness | undefined): Extension {
  return defineExtension({
    name: "mike-compaction",
    hooks: [
      hook(CompactionTask, {
        async beforeCompact(compaction, api, context) {
          const model = summarizerModel(compaction.messages, api);
          let sessionId: string = randomUUID();
          try {
            // The conversation's provider session carries the turn's user keys.
            sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId ?? sessionId;
          } catch {
            // A fresh session: endpoints with server-side keys still answer.
          }
          const { summary, fallback } = await writeSummary(
            compaction.messages,
            async ({ system, prompt }) => {
              if (!model) throw new Error("no summarizer model");
              const effort = lightestThinkingLevel(model);
              const message = await api.models.completeSimple(
                model,
                { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
                {
                  maxTokens: Math.min(
                    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
                    SUMMARY_MAX_TOKENS + (model.reasoning ? SUMMARY_THINKING_HEADROOM : 0),
                  ),
                  ...(effort ? { reasoning: effort } : {}),
                  cacheRetention: "none",
                  sessionId,
                },
              );
              if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
                throw new Error(`summary ${message.stopReason}`);
              }
              return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
            },
            compaction.instructions === undefined ? {} : { instructions: compaction.instructions },
          );
          if (fallback) console.warn("[pi] compaction summary fell back to the excerpt", { conversation: api.conversationId });
          return { summary };
        },
      }),
      hook(GenerationTask, {
        async afterResponse(message, api) {
          const conversation = api.conversationId as number;
          if (running.has(conversation) || message.stopReason === "error" || message.stopReason === "aborted") return;
          const model = api.models.getModel(message.provider, message.model);
          const threshold =
            thresholds.get(conversation) ?? (model && model.contextWindow > 0 ? defaultAutocompactTokens(model.contextWindow) : undefined);
          if (threshold === undefined || contextTokens(message) < threshold) return;
          const open = harness();
          if (!open) return;
          running.add(conversation);
          try {
            const handle = await open.conversation(api.conversationId as ConversationId, background);
            if (!handle) {
              running.delete(conversation);
              return;
            }
            const task = await handle.compact(undefined, background);
            // Not awaited: the summary is placed at the next boundary while the turn goes on.
            void open
              .waitForTask(task, background)
              .catch(() => undefined)
              .finally(() => running.delete(conversation));
          } catch (error) {
            running.delete(conversation);
            console.error("[pi] auto-compaction failed to start", safeError(error));
          }
        },
      }),
    ],
  });
}
