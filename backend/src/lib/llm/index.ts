// Mike's model boundary. Every model runs on Pi Durable and pi-ai
// (`./pi/runtime.mts`); the runtime is ESM-only, so it is loaded with a
// dynamic import.
import type {
    StreamChatParams,
    StreamChatResult,
    SubagentTranscript,
    UserApiKeys,
} from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { streamChatWithToolsOnPi } = await import("./pi/runtime.mjs");
    return streamChatWithToolsOnPi(params);
}

/**
 * A chat forked into a new one: the new chat's model transcript forks at the
 * same answer, so its first turn continues from the cached prefix.
 */
export async function forkChatLineage(params: {
    fromChatId: string;
    toChatId: string;
    atMessageId: string;
    /** Source message id -> its copy in the new chat. */
    messageIds: Record<string, string>;
}): Promise<void> {
    const { forkChatLineageOnPi } = await import("./pi/runtime.mjs");
    await forkChatLineageOnPi(params);
}

/** A turn a previous process left in flight, with the context its caller stored. */
export type InterruptedTurn = {
    assistantMessageId: string;
    chatKey: string;
    context: unknown;
    startedAt: number;
};

/** Turns a previous process left in flight, oldest first. */
export async function interruptedTurns(): Promise<InterruptedTurn[]> {
    const { interruptedTurnsOnPi } = await import("./pi/runtime.mjs");
    return (await interruptedTurnsOnPi()).map((turn) => ({
        assistantMessageId: turn.assistantMessageId,
        chatKey: turn.chatKey,
        context: turn.context,
        startedAt: turn.startedAt,
    }));
}

/**
 * A durable turn's outcome is stored: forget it. Until then an answered turn
 * stays resumable, so a crash before the store drives it again.
 */
export async function finishTurn(assistantMessageId: string): Promise<void> {
    const { finishTurnOnPi } = await import("./pi/runtime.mjs");
    await finishTurnOnPi(assistantMessageId);
}

/** Give up an interrupted turn: stop its run and forget it. */
export async function abandonTurn(assistantMessageId: string): Promise<void> {
    const { abandonTurnOnPi } = await import("./pi/runtime.mjs");
    await abandonTurnOnPi(assistantMessageId);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const { completeTextOnPi } = await import("./pi/runtime.mjs");
    return completeTextOnPi(params);
}

/** A subagent's record and work, or null when no subagent has this id. */
export async function subagentTranscript(
    childId: string,
): Promise<SubagentTranscript | null> {
    const { subagentTranscriptOnPi } = await import("./pi/runtime.mjs");
    return subagentTranscriptOnPi(childId);
}
