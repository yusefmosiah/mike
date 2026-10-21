// Per-model auto-compact thresholds: where a long chat on a model compacts,
// set from the composer with `/autocompact <n>k`. Stored on the profile as a
// map from Mike model id to a token count; a model missing from the map uses
// the runtime's default for its context window.
import type { Db } from "../../lib/db";
import { LEGACY_MODEL_IDS, autocompactPolicy, contextWindow, resolveModel } from "../../lib/llm";
import { resolveRequestedModel } from "../../lib/routerModels";
import { UserFacingError } from "../../lib/userFacingError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { ensureProfileRow } from "./user.profile.load";

export type AutocompactSetting = {
    model: string;
    /** The person's threshold for this model, or null for the default. */
    tokens: number | null;
    /** Where the model compacts when the person set nothing. */
    defaultTokens: number;
    /** The threshold in effect: `tokens ?? defaultTokens`. */
    effectiveTokens: number;
    contextWindow: number;
    minTokens: number;
    maxTokens: number;
};

function isMissingColumn(error: unknown): boolean {
    const record = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
    return (
        record.code === "42703" &&
        typeof record.message === "string" &&
        record.message.includes("autocompact_tokens")
    );
}

/**
 * Keep only well-formed entries: a stored map is data, not trusted shape.
 * A threshold saved under a renamed model id moves to the current id, unless
 * the current id has its own; the next write then drops the old key.
 */
function normalizeMap(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const map: Record<string, number> = {};
    const legacy: Record<string, number> = {};
    for (const [model, tokens] of Object.entries(value as Record<string, unknown>)) {
        if (typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0) {
            const current = Object.hasOwn(LEGACY_MODEL_IDS, model) ? LEGACY_MODEL_IDS[model] : undefined;
            if (current) legacy[current] = tokens;
            else map[model] = tokens;
        }
    }
    for (const [model, tokens] of Object.entries(legacy)) map[model] ??= tokens;
    return map;
}

async function readMap(
    db: Db,
    userId: string,
): Promise<{ ok: true; map: Record<string, number> } | { ok: false; error: unknown }> {
    const { data, error } = await db
        .from("user_profiles")
        .select("autocompact_tokens")
        .eq("user_id", userId)
        .maybeSingle();
    // Before the migration nobody has set anything.
    if (error && isMissingColumn(error)) return { ok: true, map: {} };
    if (error) return { ok: false, error };
    return {
        ok: true,
        map: normalizeMap((data as { autocompact_tokens?: unknown } | null)?.autocompact_tokens),
    };
}

/**
 * The person's threshold for `model`, for a chat turn: undefined when they set
 * none, or when it cannot be read (the default then applies).
 */
export async function getAutocompactTokensFor(
    db: Db,
    userId: string,
    model: string,
): Promise<number | undefined> {
    const read = await readMap(db, userId).catch(() => null);
    if (!read?.ok) return undefined;
    return read.map[model];
}

type ResolvedModel = {
    model: string;
    contextWindow: number;
    defaultTokens: number;
    minTokens: number;
    maxTokens: number;
};

/** A model the person can select, with the window and bounds its threshold must respect. */
async function resolveAutocompactModel(
    db: Db,
    userId: string,
    raw: unknown,
): Promise<ServiceResult<ResolvedModel>> {
    const requested = typeof raw === "string" ? raw.trim() : "";
    if (!requested) return failure("validation", "Select a model first.");
    const resolved = resolveModel(requested, "");
    if (!resolved) return failure("validation", "That model is not available. Select another model.");
    let model: string;
    try {
        model = await resolveRequestedModel(resolved, "", userId, db, "throw");
    } catch (error) {
        if (error instanceof UserFacingError) return failure("validation", error.message);
        return internalFailure(error);
    }
    const window = await contextWindow(model);
    if (!window) {
        return failure("validation", "Auto-compact cannot be set for this model.");
    }
    const policy = await autocompactPolicy();
    return ok({
        model,
        contextWindow: window,
        defaultTokens: policy.defaultTokens(window),
        minTokens: policy.minTokens,
        maxTokens: Math.min(policy.maxTokens, window),
    });
}

function settingFor(resolved: ResolvedModel, tokens: number | null): AutocompactSetting {
    return {
        model: resolved.model,
        tokens,
        defaultTokens: resolved.defaultTokens,
        effectiveTokens: tokens ?? resolved.defaultTokens,
        contextWindow: resolved.contextWindow,
        minTokens: resolved.minTokens,
        maxTokens: resolved.maxTokens,
    };
}

export async function getAutocompactSetting(
    db: Db,
    userId: string,
    model: unknown,
): Promise<ServiceResult<AutocompactSetting>> {
    const resolved = await resolveAutocompactModel(db, userId, model);
    if (!resolved.ok) return resolved;
    const read = await readMap(db, userId);
    if (!read.ok) return internalFailure(read.error);
    return ok(settingFor(resolved.data, read.map[resolved.data.model] ?? null));
}

function formatThousands(tokens: number): string {
    return tokens % 1000 === 0 ? `${tokens / 1000}k` : tokens.toLocaleString("en-US");
}

/** Sets the threshold for one model; null removes it so the default applies. */
export async function setAutocompactTokens(
    db: Db,
    userId: string,
    model: unknown,
    tokens: unknown,
): Promise<ServiceResult<AutocompactSetting>> {
    if (tokens !== null && (typeof tokens !== "number" || !Number.isInteger(tokens))) {
        return failure("validation", "tokens must be a whole number of tokens or null");
    }
    const resolved = await resolveAutocompactModel(db, userId, model);
    if (!resolved.ok) return resolved;
    const { minTokens, maxTokens } = resolved.data;
    if (tokens !== null && (tokens < minTokens || tokens > maxTokens)) {
        return failure(
            "validation",
            `Choose a value from ${formatThousands(minTokens)} to ${formatThousands(maxTokens)} tokens for this model.`,
        );
    }

    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return internalFailure(ensureError);
    const read = await readMap(db, userId);
    if (!read.ok) return internalFailure(read.error);
    const next = { ...read.map };
    if (tokens === null) delete next[resolved.data.model];
    else next[resolved.data.model] = tokens;

    const { error } = await db
        .from("user_profiles")
        .update({ autocompact_tokens: next, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    if (error && isMissingColumn(error)) {
        return failure("unavailable", "Auto-compact settings are not available yet. Try again later.");
    }
    if (error) return internalFailure(error);
    return ok(settingFor(resolved.data, tokens));
}
