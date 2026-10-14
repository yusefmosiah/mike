import { describe, expect, it, vi } from "vitest";
import { MikeApiError } from "./mikeApi";
import {
    AUTOCOMPACT_USAGE,
    formatAutocompactTokens,
    parseAutocompactCommand,
    runAutocompactCommand,
    type AutocompactApi,
} from "./autocompactCommand";

const SETTING = {
    model: "opencode-go/glm-5.3-flash",
    tokens: null,
    defaultTokens: 500_000,
    effectiveTokens: 500_000,
    contextWindow: 1_000_000,
    minTokens: 20_000,
    maxTokens: 1_000_000,
};

describe("parseAutocompactCommand", () => {
    it.each([
        ["/autocompact", { kind: "show" }],
        ["  /autocompact  ", { kind: "show" }],
        ["/AutoCompact", { kind: "show" }],
        ["/autocompact 500k", { kind: "set", tokens: 500_000 }],
        ["/autocompact 421K", { kind: "set", tokens: 421_000 }],
        ["/autocompact 1m", { kind: "set", tokens: 1_000_000 }],
        ["/autocompact 1.5m", { kind: "set", tokens: 1_500_000 }],
        ["/autocompact 350000", { kind: "set", tokens: 350_000 }],
        ["/autocompact 350,000", { kind: "set", tokens: 350_000 }],
        ["/autocompact 350k tokens", { kind: "set", tokens: 350_000 }],
        ["/autocompact default", { kind: "reset" }],
        ["/autocompact Reset", { kind: "reset" }],
    ])("reads %j", (input, expected) => {
        expect(parseAutocompactCommand(input)).toEqual(expected);
    });

    it.each(["/autocompact lots", "/autocompact 500k please", "/autocompact 0", "/autocompact -5k", "/autocompact 5g"])(
        "explains how to use it for %j",
        (input) => {
            expect(parseAutocompactCommand(input)).toEqual({ kind: "invalid", message: AUTOCOMPACT_USAGE });
        },
    );

    it.each(["hello", "/autocompactx", "/autocompacting 5k", "please /autocompact 500k", "/nr /autocompact", ""])(
        "leaves an ordinary message alone: %j",
        (input) => {
            expect(parseAutocompactCommand(input)).toBeNull();
        },
    );
});

describe("formatAutocompactTokens", () => {
    it("writes round values the way they are typed", () => {
        expect(formatAutocompactTokens(500_000)).toBe("500k");
        expect(formatAutocompactTokens(421_000)).toBe("421k");
        expect(formatAutocompactTokens(1_000_000)).toBe("1m");
        expect(formatAutocompactTokens(1_500_000)).toBe("1.5m");
        expect(formatAutocompactTokens(1_234_000)).toBe("1234k");
        expect(formatAutocompactTokens(123_456)).toBe("123,456");
    });
});

function api(overrides: Partial<AutocompactApi> = {}): AutocompactApi {
    return {
        get: vi.fn(async () => SETTING),
        set: vi.fn(async (_model: string, tokens: number | null) => ({
            ...SETTING,
            tokens,
            effectiveTokens: tokens ?? SETTING.defaultTokens,
        })),
        ...overrides,
    };
}

describe("runAutocompactCommand", () => {
    const MODEL = SETTING.model;

    it("sets the value for the selected model", async () => {
        const client = api();
        expect(await runAutocompactCommand({ kind: "set", tokens: 500_000 }, MODEL, "GLM 5.3 Flash", client)).toEqual({
            tone: "info",
            text: "Auto-compact for GLM 5.3 Flash set to 500k tokens.",
        });
        expect(client.set).toHaveBeenCalledWith(MODEL, 500_000);
    });

    it("resets to the default", async () => {
        const client = api();
        expect(await runAutocompactCommand({ kind: "reset" }, MODEL, "GLM 5.3 Flash", client)).toEqual({
            tone: "info",
            text: "Auto-compact for GLM 5.3 Flash uses the default, 500k tokens.",
        });
        expect(client.set).toHaveBeenCalledWith(MODEL, null);
    });

    it("reports the current value without changing it", async () => {
        const client = api({ get: vi.fn(async () => ({ ...SETTING, tokens: 421_000, effectiveTokens: 421_000 })) });
        expect(await runAutocompactCommand({ kind: "show" }, MODEL, "GLM 5.3 Flash", client)).toEqual({
            tone: "info",
            text: "Auto-compact for GLM 5.3 Flash is set to 421k tokens.",
        });
        expect(client.set).not.toHaveBeenCalled();

        expect(await runAutocompactCommand({ kind: "show" }, MODEL, "GLM 5.3 Flash", api())).toEqual({
            tone: "info",
            text: "Auto-compact for GLM 5.3 Flash uses the default, 500k tokens.",
        });
    });

    it("asks for a model first, and never calls the API for an invalid command", async () => {
        const client = api();
        expect((await runAutocompactCommand({ kind: "show" }, null, "", client)).tone).toBe("error");
        expect(await runAutocompactCommand({ kind: "invalid", message: AUTOCOMPACT_USAGE }, MODEL, "GLM", client)).toEqual({
            tone: "error",
            text: AUTOCOMPACT_USAGE,
        });
        expect(client.get).not.toHaveBeenCalled();
        expect(client.set).not.toHaveBeenCalled();
    });

    it("shows the server's 4xx explanation, and a generic message for anything else", async () => {
        const bounds = new MikeApiError({ status: 400, message: "Choose a value from 20k to 200k tokens for this model." });
        expect(
            await runAutocompactCommand({ kind: "set", tokens: 900_000 }, MODEL, "GLM", api({ set: vi.fn(async () => { throw bounds; }) })),
        ).toEqual({ tone: "error", text: "Choose a value from 20k to 200k tokens for this model." });

        const internal = new MikeApiError({ status: 500, message: "relation user_profiles does not exist" });
        expect(
            await runAutocompactCommand({ kind: "set", tokens: 400_000 }, MODEL, "GLM", api({ set: vi.fn(async () => { throw internal; }) })),
        ).toEqual({ tone: "error", text: "Auto-compact could not be updated. Try again." });
    });
});
