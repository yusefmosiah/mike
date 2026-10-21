import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSpeakerModel, saveSpeakerModel, SPEAKER_MODEL_KEY, speakerModelConfig } from "./speakerCheck";

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

describe("speaker model choice", () => {
    it("defaults to WeSpeaker and sends nothing for it", () => {
        expect(loadSpeakerModel()).toBe("wespeaker");
        expect(speakerModelConfig()).toEqual({});
    });

    it("keeps a choice and sends it, and forgets the default", () => {
        saveSpeakerModel("both");
        expect(loadSpeakerModel()).toBe("both");
        expect(speakerModelConfig()).toEqual({ speakerModel: "both" });
        saveSpeakerModel("wespeaker");
        expect(window.localStorage.getItem(SPEAKER_MODEL_KEY)).toBeNull();
    });

    it("ignores a stored value it does not know, and blocked storage", () => {
        window.localStorage.setItem(SPEAKER_MODEL_KEY, "ecapa");
        expect(loadSpeakerModel()).toBe("wespeaker");
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(loadSpeakerModel()).toBe("wespeaker");
        expect(() => saveSpeakerModel("off")).not.toThrow();
    });
});
