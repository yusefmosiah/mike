import type { Db } from "../../lib/db";
import {
    decisionModelCatalog,
    isDecisionModelSetting,
    type DecisionModelOption,
} from "../../lib/guardrails/decisions";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

/**
 * The model that judges this user's Auto Mode tool calls: null for the
 * default (the on-route classifier on the conversation's model), or an
 * OpenRouter decision model. Read once per Auto Mode turn by the chat engine.
 */
export async function getAutoModeDecisionModel(db: Db, userId: string): Promise<string | null> {
    const { data, error } = await db
        .from("user_profiles")
        .select("auto_mode_decision_model")
        .eq("user_id", userId)
        .maybeSingle();
    // Before the migration (or on any read failure) the default judges.
    if (error || !data) return null;
    const value = (data as { auto_mode_decision_model?: unknown }).auto_mode_decision_model;
    return typeof value === "string" && isDecisionModelSetting(value) ? value : null;
}

export type AutoModeDecisionSettings = {
    model: string | null;
    options: DecisionModelOption[];
};

export async function getAutoModeDecisionSettings(
    db: Db,
    userId: string,
): Promise<ServiceResult<AutoModeDecisionSettings>> {
    try {
        const [model, options] = await Promise.all([
            getAutoModeDecisionModel(db, userId),
            decisionModelCatalog(),
        ]);
        return ok({ model, options });
    } catch (error) {
        return internalFailure(error);
    }
}

/** Saves the choice; only a model the live catalog lists (or null) is accepted. */
export async function setAutoModeDecisionModel(
    db: Db,
    userId: string,
    model: unknown,
): Promise<ServiceResult<AutoModeDecisionSettings>> {
    if (model !== null && typeof model !== "string") {
        return failure("validation", "model must be a decision model or null");
    }
    const options = await decisionModelCatalog();
    if (model !== null && !options.some((option) => option.value === model)) {
        return failure("validation", "That decision model is not available.");
    }
    const { error } = await db
        .from("user_profiles")
        .update({ auto_mode_decision_model: model })
        .eq("user_id", userId);
    if (error) return internalFailure(error);
    return ok({ model, options });
}
