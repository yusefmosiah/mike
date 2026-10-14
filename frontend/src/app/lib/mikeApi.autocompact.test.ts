import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAutocompactSetting, setAutocompactTokens } from "./mikeApi";

const fetchMock = vi.fn();
const SETTING = {
    model: "river/glm-5.3-flash",
    tokens: 400_000,
    defaultTokens: 500_000,
    effectiveTokens: 400_000,
    contextWindow: 1_048_576,
    minTokens: 20_000,
    maxTokens: 1_048_576,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(
        async () =>
            new Response(JSON.stringify(SETTING), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
    );
});

describe("auto-compact API", () => {
    it("reads a model's setting and sets or resets it", async () => {
        await expect(getAutocompactSetting("river/glm-5.3-flash")).resolves.toEqual(SETTING);
        await expect(setAutocompactTokens("river/glm-5.3-flash", 400_000)).resolves.toEqual(SETTING);
        await setAutocompactTokens("river/glm-5.3-flash", null);
        const calls = fetchMock.mock.calls as [string, RequestInit | undefined][];
        expect(String(calls[0][0])).toMatch(/\/user\/autocompact\?model=river%2Fglm-5\.3-flash$/);
        expect(calls[1][1]?.method).toBe("PUT");
        expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ model: "river/glm-5.3-flash", tokens: 400_000 });
        expect(JSON.parse(String(calls[2][1]?.body))).toEqual({ model: "river/glm-5.3-flash", tokens: null });
    });
});
