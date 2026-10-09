import { completeWithProvider, streamWithProvider } from "./providers";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    // Spike: run OpenCode Go turns on Pi Durable instead of the AI SDK loop.
    // The runtime is ESM-only, so it is loaded with a dynamic import.
    if (
        process.env.MIKE_LLM_RUNTIME === "pi" &&
        params.model.startsWith("opencode-go/")
    ) {
        const { streamChatWithToolsOnPi } = await import("./pi/runtime.mjs");
        return streamChatWithToolsOnPi(params);
    }
    return streamWithProvider(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    return completeWithProvider(params);
}
