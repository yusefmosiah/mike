import { describe, expect, it, vi } from "vitest";

import {
    estimateSetupMinutes,
    formatUsd,
    formatVoicePrice,
    measureDownloadSpeed,
    setupEstimateLabel,
} from "./pricing";

describe("formatVoicePrice", () => {
    it("shows each billing unit in words", () => {
        expect(formatVoicePrice({ unit: "per_1k_chars", usd: 0.04 })).toBe("$0.04 per 1,000 characters");
        expect(formatVoicePrice({ unit: "per_1k_chars", usd: 0.00062 })).toBe("$0.00062 per 1,000 characters");
        expect(formatVoicePrice({ unit: "per_minute", usd: 0.0002 })).toBe("$0.0002 per minute");
        expect(formatVoicePrice({ unit: "per_minute_output", usd: 0.15 })).toBe("$0.15 per minute of audio");
        expect(formatVoicePrice({ unit: "tokens", input_per_million: 2, output_per_million: 12 })).toBe("$2.00 in, $12.00 out per million tokens");
        expect(formatVoicePrice({ unit: "free" })).toBe("Free");
    });

    it("keeps two significant digits below a cent", () => {
        expect(formatUsd(0.0000453)).toBe("$0.000045");
        expect(formatUsd(1.5)).toBe("$1.50");
        expect(formatUsd(0.016)).toBe("$0.016");
        expect(formatUsd(0)).toBe("$0");
    });
});

describe("setup estimate", () => {
    it("is whole minutes, at least one, never a size", () => {
        expect(estimateSetupMinutes(206_000_000, 2_000_000)).toBe(2);
        expect(estimateSetupMinutes(1_000, 50_000_000)).toBe(1);
        expect(estimateSetupMinutes(500_000_000, 0)).toBe(1);
        expect(setupEstimateLabel(1)).toBe("about 1 minute");
        expect(setupEstimateLabel(7)).toBe("about 7 minutes");
        expect(setupEstimateLabel(7)).not.toMatch(/MB|GB|bytes/);
    });

    it("measures bytes per second over one download", async () => {
        let t = 0;
        const fetchMock = vi.fn(async () => {
            t += 500;
            return new Response(new Uint8Array(1_000_000));
        }) as unknown as typeof fetch;
        expect(await measureDownloadSpeed("https://example.test/f", { fetch: fetchMock, now: () => t })).toBe(2_000_000);
    });
});
