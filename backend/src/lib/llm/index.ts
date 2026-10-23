// Mike's model boundary. Every model runs on Pi Durable and pi-ai
// (`./pi/runtime.mts`); the runtime is ESM-only, so it is loaded with a
// dynamic import.
import type {
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
    SubagentOutcome,
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

let conversationStoreOwner = false;

/**
 * Mark this process as the owner of the durable conversation store: the one
 * serving chat turns. A background worker thread or process never is, and
 * must leave work that forks a conversation to the process that is.
 */
export function declareConversationStoreOwner(): void {
    conversationStoreOwner = true;
}

export function ownsConversationStore(): boolean {
    return conversationStoreOwner;
}

/**
 * Whether `model` can see images, from the same catalog entry a turn on it
 * uses. Unknown models cannot.
 */
export async function modelSeesImages(model: string): Promise<boolean> {
    const { modelSeesImagesOnPi } = await import("./pi/runtime.mjs");
    return modelSeesImagesOnPi(model);
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

/** One place a memory review forks from, and the first entry its context holds verbatim. */
export type MemoryReviewPoint = {
    conversation: number;
    entry: number;
    contextStart: number;
};

/**
 * Where a memory review of a chat looks from, through `atMessageId`: just
 * before each compaction since `reviewer`'s last review, then that answer.
 * `places` gives each of `messageIds` its entry (null when it has none).
 * Null when the answer has no place in the conversation store.
 */
export async function memoryReviewPoints(params: {
    chatId: string;
    reviewer: string;
    atMessageId: string;
    messageIds: readonly string[];
}): Promise<{
    points: MemoryReviewPoint[];
    places: Record<string, number | null>;
} | null> {
    const { memoryReviewPointsOnPi } = await import("./pi/runtime.mjs");
    return memoryReviewPointsOnPi(params);
}

/** Record how far `reviewer`'s memory reviews of a chat have looked. */
export async function markMemoryReviewed(params: {
    chatId: string;
    reviewer: string;
    through: number;
}): Promise<void> {
    const { markMemoryReviewedOnPi } = await import("./pi/runtime.mjs");
    await markMemoryReviewedOnPi(params);
}

export type MemoryReviewResult = {
    status: "done" | "failed";
    reply: string;
    usage: { input: number; output: number; cost: number };
};

/**
 * One memory-review turn on a fork of a conversation at `point`, which
 * repeats the conversation's cached prefix; the conversation is unchanged.
 */
export async function reviewMemory(params: {
    point: { conversation: number; entry: number };
    prompt: string;
    tools: readonly OpenAIToolSchema[];
    runTools: NonNullable<StreamChatParams["runTools"]>;
    apiKeys?: UserApiKeys;
    model?: string;
    maxRounds: number;
    signal?: AbortSignal;
}): Promise<MemoryReviewResult> {
    const { reviewMemoryOnPi } = await import("./pi/runtime.mjs");
    return reviewMemoryOnPi(params);
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

/**
 * The context window, in tokens, of the model a turn on `model` runs, from
 * the same catalog entry; undefined when the catalog cannot resolve it.
 */
export async function contextWindow(model: string): Promise<number | undefined> {
    const { contextWindowOnPi } = await import("./pi/runtime.mjs");
    return contextWindowOnPi(model);
}

/** The bounds `/autocompact` accepts, and where a chat compacts when its owner set nothing. */
export type AutocompactPolicy = {
    minTokens: number;
    maxTokens: number;
    defaultTokens: (contextWindow: number) => number;
};

export async function autocompactPolicy(): Promise<AutocompactPolicy> {
    const {
        AUTOCOMPACT_MIN_TOKENS,
        AUTOCOMPACT_MAX_TOKENS,
        defaultAutocompactTokens,
    } = await import("./pi/compaction.mjs");
    return {
        minTokens: AUTOCOMPACT_MIN_TOKENS,
        maxTokens: AUTOCOMPACT_MAX_TOKENS,
        defaultTokens: defaultAutocompactTokens,
    };
}

/** A subagent's record and work, or null when no subagent has this id. */
export async function subagentTranscript(
    childId: string,
): Promise<SubagentTranscript | null> {
    const { subagentTranscriptOnPi } = await import("./pi/runtime.mjs");
    return subagentTranscriptOnPi(childId);
}

/** A message from a chat's background subagents (lib/llm/pi/runtime.mts). */
export type AgentMessage = {
    /** The message's own id. */
    id: string;
    from: string;
    childId: string;
    agentType: string;
    kind: "report" | "message";
    status?: SubagentOutcome["status"];
    body: string;
    at: number;
    /** What the chat's assistant asked of the subagent: its task, then any work it sent it since. */
    instructions: string[];
    /** The context of the turn that started the subagent. */
    wakeContext: unknown;
};

/**
 * Tell a surface when one of its chats has messages from its background
 * subagents waiting; it takes them (takeAgentMessages) once the chat is idle.
 */
export async function setAgentMessageSink(
    sink: ((chatKey: string) => void) | undefined,
): Promise<void> {
    const runtime = await import("./pi/runtime.mjs");
    runtime.setAgentMessageSink(sink);
}

/** What a chat's background subagents sent it and it has not received, oldest first, left unreceived. */
export async function peekAgentMessages(chatKey: string): Promise<AgentMessage[]> {
    const { peekAgentMessagesOnPi } = await import("./pi/runtime.mjs");
    return peekAgentMessagesOnPi(chatKey);
}

/**
 * Take what a chat's background subagents sent it and it has not received
 * (only `ids`, when given), oldest first: each is taken once.
 */
export async function takeAgentMessages(chatKey: string, ids?: readonly string[]): Promise<AgentMessage[]> {
    const { takeAgentMessagesOnPi } = await import("./pi/runtime.mjs");
    return takeAgentMessagesOnPi(chatKey, ids);
}

/** Where a background subagent stands now: its status, its spend, and its latest report. */
export type BackgroundAgentStatus = {
    status: SubagentOutcome["status"] | "running";
    usage: SubagentOutcome["usage"] | null;
    report: string | null;
};

/** Where each of a chat's background subagents named in `childIds` stands now. */
export async function backgroundAgentStatuses(
    chatKey: string,
    childIds: readonly string[],
): Promise<Record<string, BackgroundAgentStatus>> {
    const { backgroundAgentStatusesOnPi } = await import("./pi/runtime.mjs");
    return backgroundAgentStatusesOnPi(chatKey, childIds);
}

/**
 * Stop and forget the background subagents of chats being deleted: call it
 * with the chats' ids when deleting them, cascades included.
 */
export async function deleteChatAgents(chatKeys: readonly string[]): Promise<void> {
    if (!chatKeys.length) return;
    const { deleteChatAgentsOnPi } = await import("./pi/runtime.mjs");
    return deleteChatAgentsOnPi(chatKeys);
}

/** Report the previous process's background subagents, cut off by its end, to their chats. */
export async function reportCutOffAgents(): Promise<void> {
    const { reportCutOffAgentsOnPi } = await import("./pi/runtime.mjs");
    return reportCutOffAgentsOnPi();
}

/** Chats with messages from their background subagents waiting. */
export async function chatsWithAgentMessages(): Promise<string[]> {
    const { chatsWithAgentMessagesOnPi } = await import("./pi/runtime.mjs");
    return chatsWithAgentMessagesOnPi();
}
