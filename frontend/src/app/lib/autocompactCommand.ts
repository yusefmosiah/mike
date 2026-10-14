// `/autocompact`: the composer's command for where a long chat on the
// selected model compacts. It never reaches the model.
//
//   /autocompact            report the current value
//   /autocompact 500k       set it (also `1m`, `350000`, `350,000`)
//   /autocompact default    go back to the model's default (also `reset`)

import type { AutocompactSetting } from "./mikeApi";
import { userFacingApiError } from "./userFacingError";

export const AUTOCOMPACT_COMMAND = "/autocompact";

export type AutocompactCommand =
    | { kind: "show" }
    | { kind: "reset" }
    | { kind: "set"; tokens: number }
    | { kind: "invalid"; message: string };

const COMMAND = /^\/autocompact(?:\s+([\s\S]*))?$/i;
const AMOUNT = /^(\d[\d,_]*(?:\.\d+)?)\s*([km])?(?:\s*tokens?)?$/i;

export const AUTOCOMPACT_USAGE =
    "Use /autocompact followed by a number of tokens, like /autocompact 500k, or /autocompact default.";

/**
 * The command a draft holds, or null when the draft is an ordinary message
 * (anything that is not exactly `/autocompact` and at most one value).
 */
export function parseAutocompactCommand(value: string): AutocompactCommand | null {
    const match = COMMAND.exec(value.trim());
    if (!match) return null;
    const argument = (match[1] ?? "").trim();
    if (!argument) return { kind: "show" };
    if (/^(?:default|reset)$/i.test(argument)) return { kind: "reset" };
    const amount = AMOUNT.exec(argument);
    if (!amount) return { kind: "invalid", message: AUTOCOMPACT_USAGE };
    const number = Number(amount[1].replace(/[,_]/g, ""));
    const unit = amount[2]?.toLowerCase();
    const tokens = Math.round(number * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
    if (!Number.isFinite(tokens) || tokens <= 0) {
        return { kind: "invalid", message: AUTOCOMPACT_USAGE };
    }
    return { kind: "set", tokens };
}

/** 500000 → "500k", 1000000 → "1m", 123456 → "123,456". */
export function formatAutocompactTokens(tokens: number): string {
    if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`;
    if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
    return tokens.toLocaleString("en-US");
}

export type AutocompactApi = {
    get: (model: string) => Promise<AutocompactSetting>;
    set: (model: string, tokens: number | null) => Promise<AutocompactSetting>;
};

export type AutocompactNotice = { tone: "info" | "error"; text: string };

function describe(setting: AutocompactSetting, label: string, changed: boolean): string {
    if (setting.tokens === null) {
        return `Auto-compact for ${label} uses the default, ${formatAutocompactTokens(setting.defaultTokens)} tokens.`;
    }
    return `Auto-compact for ${label} ${changed ? "set to" : "is set to"} ${formatAutocompactTokens(setting.tokens)} tokens.`;
}

/** Runs a parsed command against the API and says what happened. */
export async function runAutocompactCommand(
    command: AutocompactCommand,
    model: string | null | undefined,
    label: string,
    api: AutocompactApi,
): Promise<AutocompactNotice> {
    if (command.kind === "invalid") return { tone: "error", text: command.message };
    if (!model) return { tone: "error", text: "Select a model first, then set its auto-compact point." };
    try {
        if (command.kind === "show") {
            return { tone: "info", text: describe(await api.get(model), label, false) };
        }
        const setting = await api.set(model, command.kind === "reset" ? null : command.tokens);
        return { tone: "info", text: describe(setting, label, true) };
    } catch (error) {
        return {
            tone: "error",
            text: userFacingApiError(error, "Auto-compact could not be updated. Try again."),
        };
    }
}
