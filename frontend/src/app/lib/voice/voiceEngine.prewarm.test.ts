import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativePromise = vi.fn(async () => undefined);

async function engine(methods: string[]) {
    vi.resetModules();
    vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech", methods: methods.map((name) => ({ name })) }], nativePromise });
    return import("./voiceEngine");
}

beforeEach(() => {
    window.localStorage.clear();
    nativePromise.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("voicePrewarm", () => {
    it("does nothing until voice mode has been used", async () => {
        const { voicePrewarm } = await engine(["voiceStatus", "voicePrewarm"]);
        voicePrewarm();
        expect(nativePromise).not.toHaveBeenCalled();
    });

    it("asks the phone to load the models once voice mode has been used, once per app run", async () => {
        const { voicePrewarm, markVoiceUsed } = await engine(["voiceStatus", "voicePrewarm"]);
        markVoiceUsed();
        voicePrewarm({ speakerModel: "both" });
        voicePrewarm();
        expect(nativePromise).toHaveBeenCalledTimes(1);
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voicePrewarm", { config: { speakerModel: "both" } });
    });

    it("ignores an app build without the method", async () => {
        const { voicePrewarm, markVoiceUsed } = await engine(["voiceStatus"]);
        markVoiceUsed();
        voicePrewarm();
        expect(nativePromise).not.toHaveBeenCalled();
    });

    it("tries again after a failure", async () => {
        const { voicePrewarm, markVoiceUsed } = await engine(["voiceStatus", "voicePrewarm"]);
        markVoiceUsed();
        nativePromise.mockRejectedValueOnce(new Error("no"));
        voicePrewarm();
        await vi.waitFor(() => expect(nativePromise).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        voicePrewarm();
        expect(nativePromise).toHaveBeenCalledTimes(2);
    });

    it("does nothing when storage is blocked", async () => {
        const { voicePrewarm, markVoiceUsed } = await engine(["voiceStatus", "voicePrewarm"]);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        markVoiceUsed();
        voicePrewarm();
        expect(nativePromise).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
