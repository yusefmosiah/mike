// Where Mike's model providers live and which key a request uses: a user's own
// key first, then the deployment's environment (with the aliases Settings also
// accepts). Shared by every model runtime; free of any SDK.
import type { Provider, UserApiKeys } from "./types";

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://openrouter.ai/api/v1";
export const OPENCODE_GO_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://opencode.ai/zen/go/v1";
export const VERCEL_GATEWAY_BASE_URL =
  process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");

export type RouterProvider = Extract<
  Provider,
  "openrouter" | "vercel" | "opencode-go"
>;

export const ROUTER_LABELS: Record<RouterProvider, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
};

const ROUTER_KEY_ENV_HINTS: Record<RouterProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

// Env aliases a provider also answers to. CLAUDE_API_KEY is accepted by
// envApiKey("claude") in modules/user/user.apiKeyStore.ts, which decides
// whether Settings reports the key as configured — without the same alias here
// a deployment that only sets CLAUDE_API_KEY showed a green key and then
// failed every request with "not configured".
const ENVIRONMENT_KEY_ALIASES: Record<string, string[]> = {
  ANTHROPIC_API_KEY: ["CLAUDE_API_KEY"],
  OPENCODE_API_KEY: ["OPENCODE_GO_API_KEY"],
};

export function requiredKey(
  label: string,
  environmentVariable: string,
  override?: string | null,
): string {
  const key =
    override?.trim() ||
    process.env[environmentVariable]?.trim() ||
    (ENVIRONMENT_KEY_ALIASES[environmentVariable] ?? [])
      .map((alias) => process.env[alias]?.trim())
      .find((value) => !!value) ||
    "";
  if (!key) {
    throw new Error(
      `${label} API key is not configured. Set ${environmentVariable} or add a user ${label} key.`,
    );
  }
  return key;
}

function routerEnvironmentKey(provider: RouterProvider): string | undefined {
  if (provider === "vercel") {
    return (
      process.env.AI_GATEWAY_API_KEY?.trim() ||
      process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
    );
  }
  if (provider === "opencode-go")
    return (
      process.env.OPENCODE_API_KEY?.trim() ||
      process.env.OPENCODE_GO_API_KEY?.trim()
    );
  return process.env.OPENROUTER_API_KEY?.trim();
}

function routerUserKey(
  provider: RouterProvider,
  apiKeys?: UserApiKeys,
): string | null | undefined {
  if (provider === "vercel") return apiKeys?.vercel;
  if (provider === "opencode-go") return apiKeys?.["opencode-go"];
  return apiKeys?.openrouter;
}

export function routerKey(provider: RouterProvider, apiKeys?: UserApiKeys): string {
  const key =
    routerUserKey(provider, apiKeys)?.trim() || routerEnvironmentKey(provider);
  if (!key) {
    throw new Error(
      `${ROUTER_LABELS[provider]} API key is not configured. Set ${ROUTER_KEY_ENV_HINTS[provider]} or add a user ${ROUTER_LABELS[provider]} key.`,
    );
  }
  return key;
}

export function ollamaBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
  ).replace(/\/$/, "");
}

export function ollamaModelName(model: string): string {
  const tag = model.replace(/^ollama\/?/, "");
  return tag || process.env.OLLAMA_MODEL?.trim() || "qwen3.6";
}

export function ollamaAuthHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}


/**
 * The key a request to this provider uses, or undefined when none is
 * configured (keyless local endpoints, or a provider whose key is missing).
 */
export function providerKey(provider: Provider, apiKeys?: UserApiKeys): string | undefined {
  const attempt = (resolve: () => string) => {
    try {
      return resolve();
    } catch {
      return undefined;
    }
  };
  switch (provider) {
    case "claude":
      return attempt(() => requiredKey("Anthropic", "ANTHROPIC_API_KEY", apiKeys?.claude));
    case "gemini":
      return attempt(() => requiredKey("Gemini", "GEMINI_API_KEY", apiKeys?.gemini));
    case "openai":
      return attempt(() => requiredKey("OpenAI", "OPENAI_API_KEY", apiKeys?.openai));
    case "openrouter":
    case "vercel":
    case "opencode-go":
      return attempt(() => routerKey(provider, apiKeys));
    case "ollama":
      return process.env.OLLAMA_API_KEY?.trim() || undefined;
    case "openai-compatible":
      return undefined;
  }
}
