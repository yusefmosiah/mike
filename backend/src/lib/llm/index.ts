import { completeWithProvider, streamWithProvider } from "./providers";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    // MIKE_LLM_RUNTIME=pi runs every model on Pi Durable and pi-ai instead of
    // the AI SDK loop. The runtime is ESM-only, so it is loaded with a dynamic
    // import.
    if (piRuntimeEnabled()) {
        const { streamChatWithToolsOnPi } = await import("./pi/runtime.mjs");
        return streamChatWithToolsOnPi(params);
    }
    return streamWithProvider(params);
}

/**
 * A chat forked into a new one: the new chat's model transcript forks at the
 * same answer, so its first turn continues from the cached prefix. A no-op on
 * the AI SDK path, whose transcript is the stored messages themselves.
 */
export async function forkChatLineage(params: {
    fromChatId: string;
    toChatId: string;
    atMessageId: string;
    /** Source message id -> its copy in the new chat. */
    messageIds: Record<string, string>;
}): Promise<void> {
    if (!piRuntimeEnabled()) return;
    const { forkChatLineageOnPi } = await import("./pi/runtime.mjs");
    await forkChatLineageOnPi(params);
}

export function piRuntimeEnabled(): boolean {
    return process.env.MIKE_LLM_RUNTIME === "pi";
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    if (piRuntimeEnabled()) {
        const { completeTextOnPi } = await import("./pi/runtime.mjs");
        return completeTextOnPi(params);
    }
    return completeWithProvider(params);
}
