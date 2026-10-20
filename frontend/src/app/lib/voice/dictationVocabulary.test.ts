import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    getDictationVocabulary: vi.fn(async () => ({ terms: ["Okonkwo-Lindqvist"] })),
    saveDictationVocabulary: vi.fn(async (terms: string[]) => ({ terms })),
}));
vi.mock("@/app/lib/mikeApi", () => api);

import {
    automaticTermsFrom,
    currentDictationVocabulary,
    loadUserVocabulary,
    namesFromFilename,
    recognizerTerms,
    resetDictationVocabulary,
    saveUserVocabulary,
    setDictationContext,
    useDictationContext,
    useUserVocabulary,
} from "./dictationVocabulary";

beforeEach(() => {
    vi.clearAllMocks();
    resetDictationVocabulary();
});

describe("namesFromFilename", () => {
    it("drops the extension and splits on separators, keeping names long enough", () => {
        expect(namesFromFilename("Smith v Jones - SPA.docx")).toEqual(["Smith v Jones"]);
        expect(namesFromFilename("Okonkwo-Lindqvist_Share Purchase Agreement.pdf")).toEqual([
            "Okonkwo-Lindqvist",
            "Share Purchase Agreement",
        ]);
        expect(namesFromFilename("2024-10-01.pdf")).toEqual([]);
    });
});

describe("automaticTermsFrom", () => {
    it("takes the project, chat, files and people, once each, at least six characters", () => {
        expect(
            automaticTermsFrom({
                projectName: "Achterberg Acquisition",
                chatTitle: "Q&A",
                filenames: ["Smith v Jones - SPA.docx", "smith v jones.pdf", null],
                people: ["Ximena Achterberg", "Bo", undefined],
            }),
        ).toEqual(["Achterberg Acquisition", "Smith v Jones", "Ximena Achterberg"]);
    });

    it("caps the list at 200", () => {
        const filenames = Array.from({ length: 300 }, (_, i) => `Matter Number${i}.docx`);
        expect(automaticTermsFrom({ filenames })).toHaveLength(200);
    });
});

describe("the vocabulary in use", () => {
    it("puts the person's terms first and drops automatic duplicates of them", async () => {
        await loadUserVocabulary();
        setDictationContext("page", ["okonkwo-lindqvist", "Smith v Jones"]);
        const vocabulary = currentDictationVocabulary();
        expect(vocabulary.terms).toEqual(["Okonkwo-Lindqvist"]);
        expect(vocabulary.automatic).toEqual(["Smith v Jones"]);
        expect(recognizerTerms(vocabulary)).toEqual(["Okonkwo-Lindqvist", "Smith v Jones"]);
        setDictationContext("page", []);
        expect(currentDictationVocabulary().automatic).toEqual([]);
    });

    it("loads once while fresh, shares an in-flight load, and keeps what a save returns", async () => {
        await Promise.all([loadUserVocabulary(), loadUserVocabulary()]);
        await loadUserVocabulary();
        expect(api.getDictationVocabulary).toHaveBeenCalledTimes(1);
        await saveUserVocabulary(["A B"]);
        expect(currentDictationVocabulary().terms).toEqual(["A B"]);
    });

    it("does not remember a failed load", async () => {
        api.getDictationVocabulary.mockRejectedValueOnce(new Error("offline"));
        await expect(loadUserVocabulary()).rejects.toThrow();
        await expect(loadUserVocabulary()).resolves.toEqual(["Okonkwo-Lindqvist"]);
    });
});

describe("edges", () => {
    it("treats a malformed load as an empty list and works before any load", async () => {
        expect(currentDictationVocabulary()).toEqual({ terms: [], automatic: [] });
        expect(recognizerTerms({ terms: ["Okonkwo-Lindqvist"] })).toEqual(["Okonkwo-Lindqvist"]);
        api.getDictationVocabulary.mockResolvedValueOnce({ terms: null as unknown as string[] });
        await expect(loadUserVocabulary(true)).resolves.toEqual([]);
    });

    it("ignores withdrawing names a page never published, and names over four words", () => {
        setDictationContext("never", []);
        expect(automaticTermsFrom({ projectName: "One two three four five" })).toEqual([]);
    });
});

describe("signing out mid-load", () => {
    it("lets the next load start afresh", async () => {
        const first = loadUserVocabulary();
        resetDictationVocabulary();
        const second = loadUserVocabulary();
        expect(second).not.toBe(first);
        await Promise.all([first, second]);
        expect(api.getDictationVocabulary).toHaveBeenCalledTimes(2);
    });
});

describe("hooks", () => {
    it("gives Settings nothing until the list loads, then the list sorted", async () => {
        const { result, rerender } = renderHook(() => useUserVocabulary());
        expect(result.current).toBeNull();
        rerender();
        api.getDictationVocabulary.mockResolvedValueOnce({ terms: ["Zeta Holdings", "alpha Trust"] });
        await act(() => loadUserVocabulary());
        expect(result.current).toEqual(["alpha Trust", "Zeta Holdings"]);
    });

    it("publishes a page's names while it is mounted", () => {
        const first = { chatTitle: "Smith v Jones" };
        const { rerender, unmount } = renderHook(({ input }) => useDictationContext("chat", input), {
            initialProps: { input: first },
        });
        expect(currentDictationVocabulary().automatic).toEqual(["Smith v Jones"]);
        rerender({ input: first });
        rerender({ input: { chatTitle: "Okonkwo Holdings" } });
        expect(currentDictationVocabulary().automatic).toEqual(["Okonkwo Holdings"]);
        unmount();
        expect(currentDictationVocabulary().automatic).toEqual([]);
    });
});
