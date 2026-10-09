/**
 * Voice prices and the browser-model setup estimate (goals/mission-10-voice.md).
 * Prices mirror the backend's normalized OpenRouter units; setup time is
 * always shown in minutes, never as a download size.
 */

export type VoicePrice =
    | { unit: "per_1k_chars"; usd: number }
    | { unit: "per_minute"; usd: number }
    | { unit: "per_minute_output"; usd: number }
    | { unit: "tokens"; input_per_million: number; output_per_million: number }
    | { unit: "free" };

/** Dollars and cents from 10 cents up; two significant digits below that. */
export function formatUsd(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return "$0";
    if (amount >= 0.1) return `$${amount.toFixed(2)}`;
    return `$${Number(amount.toPrecision(2)).toString()}`;
}

export function formatVoicePrice(price: VoicePrice): string {
    switch (price.unit) {
        case "per_1k_chars":
            return `${formatUsd(price.usd)} per 1,000 characters`;
        case "per_minute":
            return `${formatUsd(price.usd)} per minute`;
        case "per_minute_output":
            return `${formatUsd(price.usd)} per minute of audio`;
        case "tokens":
            return `${formatUsd(price.input_per_million)} in, ${formatUsd(price.output_per_million)} out per million tokens`;
        case "free":
            return "Free";
    }
}

/** Whole minutes to fetch `totalBytes` at the measured rate, at least 1. */
export function estimateSetupMinutes(totalBytes: number, bytesPerSecond: number): number {
    if (!(bytesPerSecond > 0) || !(totalBytes > 0)) return 1;
    return Math.max(1, Math.ceil(totalBytes / bytesPerSecond / 60));
}

export function setupEstimateLabel(minutes: number): string {
    return minutes <= 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

/**
 * Bytes per second over one small download. `url` should be a file of a few
 * hundred kilobytes on the same host the model comes from.
 */
export async function measureDownloadSpeed(
    url: string,
    deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<number> {
    const doFetch = deps.fetch ?? fetch;
    const now = deps.now ?? (() => performance.now());
    const started = now();
    const response = await doFetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("speed test failed");
    const bytes = (await response.arrayBuffer()).byteLength;
    const seconds = Math.max((now() - started) / 1000, 0.001);
    return bytes / seconds;
}
