import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDictationVocabulary, saveDictationVocabulary } from "./mikeApi";

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(
        async () =>
            new Response(JSON.stringify({ terms: ["Ximena Achterberg"] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
    );
});

describe("dictation vocabulary API", () => {
    it("reads the list and replaces it", async () => {
        await expect(getDictationVocabulary()).resolves.toEqual({ terms: ["Ximena Achterberg"] });
        await expect(saveDictationVocabulary(["Ximena Achterberg"])).resolves.toEqual({
            terms: ["Ximena Achterberg"],
        });
        const calls = fetchMock.mock.calls as [string, RequestInit | undefined][];
        expect(String(calls[0][0])).toMatch(/\/user\/dictation-vocabulary$/);
        expect(calls[1][1]?.method).toBe("PUT");
        expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ terms: ["Ximena Achterberg"] });
    });
});
