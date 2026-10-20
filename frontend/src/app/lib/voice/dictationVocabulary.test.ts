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
