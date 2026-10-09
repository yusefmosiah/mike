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
