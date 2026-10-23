// Turns a previous process left in flight (a deploy, a crash), handed back to
// the surface that started each one.
//
// Pi keeps every durable turn with the context its route stored; the context
// names its surface. This is the composition root that maps a surface onto
// its module's resumer, so no module has to know which turns are the others'.
// A turn no surface claims is given up: nothing could rebuild its tools.
import type { Db } from "./lib/db";
import {
  abandonTurn,
  chatsWithAgentMessages,
  interruptedTurns,
  setAgentMessageSink,
  type InterruptedTurn,
} from "./lib/llm";
import { safeError } from "./lib/safeError";
import { deliverAgentMessages, resumeInterruptedChatTurn } from "./modules/chat/chat.service";
import { resumeInterruptedProjectChatTurn } from "./modules/project-chat/projectChat.service";
import { resumeInterruptedTabularChatTurn } from "./modules/tabular/tabular.service";
import { resumeInterruptedWordChatTurn } from "./modules/word-chat/wordChat.service";

export type TurnResumer = (db: Db, turn: InterruptedTurn) => Promise<void>;

export const TURN_RESUMERS: Readonly<Record<string, TurnResumer>> = {
  chat: resumeInterruptedChatTurn,
  "project-chat": resumeInterruptedProjectChatTurn,
  word: resumeInterruptedWordChatTurn,
  tabular: resumeInterruptedTabularChatTurn,
};

function surfaceOf(turn: InterruptedTurn): string | null {
  const surface = (turn.context as { surface?: unknown } | null)?.surface;
  return typeof surface === "string" ? surface : null;
}

/**
 * Drive again every turn a previous process left in flight. Concurrently:
 * each drive lasts as long as its turn's generation.
 */
export async function resumeInterruptedTurns(
  db: Db,
  deps: {
    pending?: () => Promise<InterruptedTurn[]>;
    resumers?: Readonly<Record<string, TurnResumer>>;
    abandon?: (assistantMessageId: string) => Promise<void>;
  } = {},
): Promise<void> {
  const resumers = deps.resumers ?? TURN_RESUMERS;
  const abandon = deps.abandon ?? abandonTurn;
  let pending: InterruptedTurn[];
  try {
    pending = await (deps.pending ?? interruptedTurns)();
  } catch (error) {
    console.error("[resume] could not read interrupted turns", safeError(error));
    return;
  }
  await Promise.all(
    pending.map(async (turn) => {
      const surface = surfaceOf(turn);
      const resume = surface ? resumers[surface] : undefined;
      try {
        if (resume) await resume(db, turn);
        else await abandon(turn.assistantMessageId);
      } catch (error) {
        console.error("[resume] failed to resume a turn", { surface, error: safeError(error) });
      }
    }),
  );
}

/**
 * Hand what background subagents send an idle chat to the chat module, which
 * starts a turn that answers it: now for what the previous process left
 * waiting, and from now on as each arrives. Background subagents run only in
 * chats today.
 */
export async function startAgentMessageDelivery(
  db: Db,
  deps: {
    deliver?: (db: Db, chatId: string) => Promise<void>;
    setSink?: typeof setAgentMessageSink;
    waiting?: () => Promise<string[]>;
  } = {},
): Promise<void> {
  const deliver = deps.deliver ?? deliverAgentMessages;
  try {
    await (deps.setSink ?? setAgentMessageSink)((chatId) => void deliver(db, chatId));
    for (const chatId of await (deps.waiting ?? chatsWithAgentMessages)()) void deliver(db, chatId);
  } catch (error) {
    console.error("[agents] could not start delivering subagent messages", safeError(error));
  }
}
