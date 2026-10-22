// Wires Mike's compaction (compaction.mts) into pi-durable: the summary every
// compaction writes, with the conversation's memory as it is now, and the
// owner's auto-compact threshold.

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  type Agent,
  type ConversationId,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import { safeError } from "../../safeError.js";
import { defaultAutocompactTokens, messageIds, writeSummary } from "./compaction.mjs";

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

/** How each conversation's latest turn reads its memory, for the summary to carry. */
const memories = new Map<number, () => Promise<string | null>>();

export function setCompactionMemory(conversation: number, read: (() => Promise<string | null>) | undefined): void {
  if (read === undefined) memories.delete(conversation);
  else memories.set(conversation, read);
}

/** The conversation's memory now, or null; a failure to read it never fails the compaction. */
async function memoryNow(conversation: number): Promise<string | null> {
  try {
    return (await memories.get(conversation)?.()) ?? null;
  } catch (error) {
    console.warn("[pi] compaction could not read memory", safeError(error));
    return null;
  }
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
          let sessionId: string = randomUUID();
          try {
            // The conversation's provider session carries the turn's user keys.
            sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId ?? sessionId;
          } catch {
            // A fresh session: endpoints with server-side keys still answer.
          }
          // The next turn's request, sent with its model and options (compaction.mts).
          let conversation: readonly Message[] = [];
          let agent: Agent | undefined;
          try {
            const handle = await harness()?.conversation(api.conversationId, context);
            if (handle) [{ messages: conversation }, agent] = await Promise.all([handle.context(context), handle.agent(context)]);
          } catch (error) {
            console.error("[pi] compaction could not read the conversation", safeError(error));
          }
          const model = agent?.model && api.models.getModel(agent.model.provider, agent.model.modelId);
          const thinkingLevel = agent?.thinkingLevel;
          const memory = await memoryNow(api.conversationId as number);
          const { summary, usage, failure } = await writeSummary(
            conversation,
            compaction.messages,
            async (messages) => {
              if (!model) throw new Error("no model");
              // As pi-durable sends a turn: Mike's Harness sets no stream options.
              return api.models.completeSimple(
                model,
                { messages },
                { sessionId, ...(thinkingLevel === undefined || thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }) },
              );
            },
            compaction.instructions === undefined ? {} : { instructions: compaction.instructions },
            { ids: messageIds(compaction.entries as never), memory },
          );
          if (failure !== undefined) {
            console.warn("[pi] compaction summary fell back to the excerpt", { conversation: api.conversationId, reason: failure });
          } else if (usage) {
            const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
            console.info("[pi] compaction summary written", {
              conversation: api.conversationId,
              tokens,
              fromCache: `${Math.round((100 * usage.cacheRead) / Math.max(1, tokens))}%`,
            });
          }
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
