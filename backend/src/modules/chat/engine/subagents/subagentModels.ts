import type { Db } from "../../../../lib/db";
import { configuredEndpointSummaries } from "../../../../lib/llm/registry";
import {
    CLAUDE_LOW_MODELS,
    CLAUDE_MAIN_MODELS,
    GEMINI_LOW_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_LOW_MODELS,
    OPENAI_MAIN_MODELS,
    providerForModel,
} from "../../../../lib/llm/models";
import type { UserApiKeys } from "../../../../lib/llm/types";
import { assertModelAllowed, isStrictPrivateMode } from "../../../../lib/privateMode";
import { getAllUserRouterModels, ROUTER_SLUGS } from "../../../../lib/routerModels";

/**
 * The models a subagent may run on for one user: the ones the user could pick
 * for the chat itself. A `delegate` call naming any other model is refused
 * with this list, so the caller can choose again.
 */
export type DelegableModel = {
    id: string;
    speed: SpeedTier;
    /** What a million tokens cost, input / output, when known. */
    price: string;
};

export type SpeedTier = "fast" | "standard" | "deep";

/**
 * A rough speed and depth tier from the model's name: small, flash and lite
 * models answer fastest; the largest ones think longest. Good enough to sort
 * a choice; the memo says how to use it.
 */
export function speedTier(model: string): SpeedTier {
    const name = model.toLowerCase();
    if (/(flash-lite|lite\b|-lite|(?:^|[-/_])mini\b|nano|haiku|luna|\bsmall\b|[^0-9][1-9]b\b|flash)/.test(name)) {
        return "fast";
    }
    if (/(opus|fable|-pro\b|pro-preview|\bsol\b|-sol\b|ultra|\bmax\b|-max\b)/.test(name)) {
        return "deep";
    }
    return "standard";
}

const STATIC_MODELS: Record<"claude" | "gemini" | "openai", readonly string[]> = {
    claude: [...new Set([...CLAUDE_MAIN_MODELS, ...CLAUDE_LOW_MODELS])],
    gemini: [...new Set([...GEMINI_MAIN_MODELS, ...GEMINI_LOW_MODELS])],
    openai: [...new Set([...OPENAI_MAIN_MODELS, ...OPENAI_LOW_MODELS])],
};

/** OpenRouter's public list prices, by catalog id, refreshed at most every six hours. */
type PriceTable = Map<string, { input: number; output: number }>;
let prices: { at: number; table: PriceTable } | undefined;
const PRICE_TTL_MS = 6 * 60 * 60_000;

async function openRouterPrices(fetchImpl: typeof fetch = fetch): Promise<PriceTable> {
    // Strict private mode sends nothing to a hosted service, a price list included.
    if (isStrictPrivateMode()) return new Map();
    if (prices && Date.now() - prices.at < PRICE_TTL_MS) return prices.table;
    const table: PriceTable = new Map();
    try {
        const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
            signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
            const payload = (await response.json()) as {
                data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }>;
            };
            for (const model of payload.data ?? []) {
                const input = Number(model.pricing?.prompt);
                const output = Number(model.pricing?.completion);
                if (typeof model.id === "string" && Number.isFinite(input) && Number.isFinite(output)) {
                    table.set(model.id, { input: input * 1e6, output: output * 1e6 });
                }
            }
        }
    } catch {
        // Prices are a convenience; the table still lists every model.
    }
    prices = { at: Date.now(), table };
    return table;
}

/** Test hook. */
export function resetSubagentPriceCacheForTests(): void {
    prices = undefined;
}

/** OpenRouter catalog ids a Mike model id may be listed under. */
function catalogCandidates(id: string): string[] {
    if (id.startsWith("openrouter/")) return [id.slice("openrouter/".length)];
    if (id.startsWith("claude")) {
        // claude-sonnet-4-6 is listed as anthropic/claude-sonnet-4.6.
        return [`anthropic/${id}`, `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`];
    }
    if (id.startsWith("gemini")) return [`google/${id}`];
    if (id.startsWith("gpt-")) return [`openai/${id}`];
    return [];
}

function money(value: number): string {
    return value >= 10 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

function priceFor(id: string, table: PriceTable): string {
    if (id.startsWith("opencode-go/")) return "flat subscription";
    if (id.startsWith("ollama/")) return "self-hosted";
    for (const candidate of catalogCandidates(id)) {
        const price = table.get(candidate);
        if (price) return `${money(price.input)} / ${money(price.output)}`;
    }
    return "unknown";
}

/**
 * Every model this user may give a subagent, the chat's own first. Static
 * models need the provider's key (the user's or the deployment's), router
 * models the user's saved selection, configured endpoints their key source;
 * strict private mode removes hosted lanes.
 */
export async function delegableModels(args: {
    db: Db;
    userId: string;
    apiKeys?: UserApiKeys;
    chatModel: string;
    fetchImpl?: typeof fetch;
}): Promise<DelegableModel[]> {
    const { db, userId, apiKeys, chatModel } = args;
    const ids: string[] = [chatModel];
    for (const provider of ["claude", "gemini", "openai"] as const) {
        if (apiKeys?.[provider]?.trim()) ids.push(...STATIC_MODELS[provider]);
    }
    const routers = await getAllUserRouterModels(userId, db);
    for (const slug of ROUTER_SLUGS) {
        if (!apiKeys?.[slug]?.trim()) continue;
        for (const model of routers[slug] ?? []) ids.push(`${slug}/${model}`);
    }
    for (const endpoint of configuredEndpointSummaries(apiKeys ?? undefined)) {
        if (endpoint.available) ids.push(endpoint.id);
    }

    const allowed = [...new Set(ids)].filter((id) => {
        try {
            providerForModel(id);
            assertModelAllowed(id);
            return true;
        } catch {
            return false;
        }
    });
    const table = await openRouterPrices(args.fetchImpl);
    return allowed.map((id) => ({ id, speed: speedTier(id), price: priceFor(id, table) }));
}

/** The models as a table for the system prompt, the conversation's own marked. */
export function delegableModelsTable(models: DelegableModel[], chatModel: string): string {
    const rows = models.map(
        (model) =>
            `| ${model.id}${model.id === chatModel ? " (this conversation's model)" : ""} | ${model.speed} | ${model.price} |`,
    );
    return [
        "| model | speed | price per 1M tokens, input / output |",
        "| --- | --- | --- |",
        ...rows,
    ].join("\n");
}
