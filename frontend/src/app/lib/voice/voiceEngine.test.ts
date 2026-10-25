import { afterEach, describe, expect, it, vi } from "vitest";
import {
    endedMessage,
    onVoiceEvent,
    parseVoiceEvent,
    VOICE_BUSY_MESSAGE,
    VOICE_FORGET_FAILURE_MESSAGE,
    VOICE_INSTALL_FAILURE_MESSAGE,
    VOICE_REMOVE_FAILURE_MESSAGE,
    VOICE_MICROPHONE_MESSAGE,
    VOICE_START_FAILURE_MESSAGE,
    VOICE_UNAVAILABLE_MESSAGE,
    voiceCancelAnswer,
    voiceChatSupported,
    voiceEndAnswer,
    VoiceEngineError,
    voiceForgetSpeaker,
    voiceForgetSpeakerSupported,
    voiceInstall,
    voiceMicrophoneModes,
    voiceMicrophoneModesSupported,
    voiceRemove,
    voiceSpeak,
    voiceSpeakStep,
    voiceStart,
    voiceStatus,
    voiceStop,
    type VoiceEvent,
} from "./voiceEngine";

const nativePromise = vi.fn();
const remove = vi.fn();
let emit: (data: unknown) => void = () => undefined;
const addListener = vi.fn((_plugin: string, _event: string, callback: (data: unknown) => void) => {
    emit = callback;
    return { remove };
});

function inApp(methods: string[] = ["voiceStatus"], listeners = true) {
    vi.stubGlobal("Capacitor", {
        PluginHeaders: [{ name: "MikeSpeech", methods: methods.map((name) => ({ name })) }],
        nativePromise,
        ...(listeners ? { addListener } : {}),
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    nativePromise.mockReset();
    remove.mockReset();
    addListener.mockClear();
});

describe("voiceChatSupported", () => {
    it("is true only in an app build whose plugin has the voice engine", () => {
        expect(voiceChatSupported()).toBe(false);
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech" }] });
        expect(voiceChatSupported()).toBe(false);
        // The Android app registers the plugin without methods for now.
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech", methods: [] }], nativePromise });
        expect(voiceChatSupported()).toBe(false);
        inApp(["speak", "transcribe"]);
        expect(voiceChatSupported()).toBe(false);
        vi.stubGlobal("Capacitor", { nativePromise });
        expect(voiceChatSupported()).toBe(false);
        inApp();
        expect(voiceChatSupported()).toBe(true);
        vi.stubGlobal("window", undefined);
        expect(voiceChatSupported()).toBe(false);
    });
});

const IDLE = { preparing: false, firstTime: false, ready: [] as string[] };

describe("voiceStatus and voiceInstall", () => {
    it("reads the engine's status, and anything wrong as unavailable", async () => {
        expect(await voiceStatus()).toEqual({ available: false, missing: [], downloadBytes: 0, speakerLearned: false, ...IDLE });
        inApp();
        nativePromise.mockResolvedValueOnce({ available: false, missing: ["eou", 3, "phonon"], downloadBytes: 450e6 });
        expect(await voiceStatus()).toEqual({ available: false, missing: ["eou", "phonon"], downloadBytes: 450e6, speakerLearned: false, ...IDLE });
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceStatus", undefined);
        nativePromise.mockResolvedValueOnce({ available: true, downloadBytes: -1 });
        expect(await voiceStatus()).toEqual({ available: true, missing: [], downloadBytes: 0, speakerLearned: false, ...IDLE });
        nativePromise.mockResolvedValueOnce(null);
        expect(await voiceStatus()).toEqual({ available: false, missing: [], downloadBytes: 0, speakerLearned: false, ...IDLE });
        nativePromise.mockRejectedValueOnce({ code: "failed" });
        expect(await voiceStatus()).toEqual({ available: false, missing: [], downloadBytes: 0, speakerLearned: false, ...IDLE });
    });

    it("installs, and says why it could not", async () => {
        await expect(voiceInstall()).rejects.toMatchObject({ message: VOICE_INSTALL_FAILURE_MESSAGE, code: "unavailable" });
        inApp();
        nativePromise.mockResolvedValueOnce({ available: true });
        expect(await voiceInstall()).toBe(true);
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceInstall", undefined);
        nativePromise.mockResolvedValueOnce({});
        expect(await voiceInstall()).toBe(false);
        nativePromise.mockRejectedValueOnce(new Error("offline"));
        await expect(voiceInstall()).rejects.toMatchObject({ message: VOICE_INSTALL_FAILURE_MESSAGE, code: undefined });
    });
});

describe("voiceForgetSpeaker and voiceMicrophoneModes", () => {
    it("forgets the learned voice and resolves the status, saying why it could not", async () => {
        await expect(voiceForgetSpeaker()).rejects.toMatchObject({ message: VOICE_FORGET_FAILURE_MESSAGE, code: "unavailable" });
        inApp(["voiceStatus", "voiceForgetSpeaker"]);
        expect(voiceForgetSpeakerSupported()).toBe(true);
        nativePromise.mockResolvedValueOnce({ available: true, missing: [], downloadBytes: 0, speakerLearned: false });
        expect(await voiceForgetSpeaker()).toEqual({ available: true, missing: [], downloadBytes: 0, speakerLearned: false, ...IDLE });
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceForgetSpeaker", undefined);
        nativePromise.mockRejectedValueOnce(new Error("disk"));
        await expect(voiceForgetSpeaker()).rejects.toMatchObject({ message: VOICE_FORGET_FAILURE_MESSAGE, code: undefined });
    });

    it("reads the learned voice from the status", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ available: true, speakerLearned: true });
        expect((await voiceStatus()).speakerLearned).toBe(true);
        nativePromise.mockResolvedValueOnce({ available: true, speakerLearned: "yes" });
        expect((await voiceStatus()).speakerLearned).toBe(false);
    });

    it("reads the preparation fields, and reads an older app build as idle", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({
            available: true,
            preparing: true,
            firstTime: true,
            ready: ["vad", 3, "phonon"],
        });
        expect(await voiceStatus()).toMatchObject({ preparing: true, firstTime: true, ready: ["vad", "phonon"] });
        nativePromise.mockResolvedValueOnce({ available: true, preparing: "yes", ready: "vad" });
        expect(await voiceStatus()).toMatchObject({ preparing: false, firstTime: false, ready: [] });
    });

    it("opens the microphone modes only where the app has them, and never rejects", async () => {
        inApp();
        expect(voiceMicrophoneModesSupported()).toBe(false);
        expect(voiceForgetSpeakerSupported()).toBe(false);
        inApp(["voiceStatus", "voiceMicrophoneModes"]);
        expect(voiceMicrophoneModesSupported()).toBe(true);
        nativePromise.mockRejectedValueOnce(new Error("no"));
        await expect(voiceMicrophoneModes()).resolves.toBeUndefined();
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceMicrophoneModes", undefined);
    });
});

describe("voiceRemove", () => {
    it("removes the models and resolves the status, saying why it could not", async () => {
        await expect(voiceRemove()).rejects.toMatchObject({ message: VOICE_REMOVE_FAILURE_MESSAGE, code: "unavailable" });
        inApp();
        nativePromise.mockResolvedValueOnce({ available: false, missing: ["vad", "eou", "smart-turn"], downloadBytes: 9e6 });
        expect(await voiceRemove()).toEqual({ available: false, missing: ["vad", "eou", "smart-turn"], downloadBytes: 9e6, speakerLearned: false, ...IDLE });
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceRemove", undefined);
        nativePromise.mockRejectedValueOnce({ code: "busy" });
        await expect(voiceRemove()).rejects.toMatchObject({ message: VOICE_BUSY_MESSAGE, code: "busy" });
        nativePromise.mockRejectedValueOnce(new Error("disk"));
        const failure = voiceRemove();
        await expect(failure).rejects.toBeInstanceOf(VoiceEngineError);
        await expect(failure).rejects.toMatchObject({ message: VOICE_REMOVE_FAILURE_MESSAGE, code: undefined });
    });
});

describe("voiceStart and the answer methods", () => {
    it("starts with the config and the chosen voice, mapping failures to messages", async () => {
        inApp();
        nativePromise.mockResolvedValue(undefined);
        await voiceStart({ config: { pauseMs: 300 }, voice: "alba" });
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceStart", { config: { pauseMs: 300 }, voice: "alba" });
        await voiceStart({ config: {} });
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceStart", { config: {} });
        nativePromise.mockRejectedValueOnce({ code: "permission-denied" });
        await expect(voiceStart({ config: {} })).rejects.toMatchObject({ message: VOICE_MICROPHONE_MESSAGE, code: "permission-denied" });
        nativePromise.mockRejectedValueOnce({ code: "unavailable" });
        await expect(voiceStart({ config: {} })).rejects.toMatchObject({ message: VOICE_UNAVAILABLE_MESSAGE });
        nativePromise.mockRejectedValueOnce({ code: "failed" });
        await expect(voiceStart({ config: {} })).rejects.toBeInstanceOf(VoiceEngineError);
        nativePromise.mockRejectedValueOnce(new Error("raw native detail"));
        await expect(voiceStart({ config: {} })).rejects.toMatchObject({ message: VOICE_START_FAILURE_MESSAGE, code: undefined });
    });

    it("speaks, ends, cancels and stops without ever rejecting", async () => {
        inApp();
        nativePromise.mockResolvedValue(undefined);
        voiceSpeak("t1", 0, "First clause,");
        voiceSpeak("t1", 1, "and the last.", true);
        voiceEndAnswer("t1");
        await voiceCancelAnswer("t1");
        await voiceStop();
        expect(nativePromise.mock.calls).toEqual([
            ["MikeSpeech", "voiceSpeak", { turnId: "t1", clauseId: 0, text: "First clause," }],
            ["MikeSpeech", "voiceSpeak", { turnId: "t1", clauseId: 1, text: "and the last.", final: true }],
            ["MikeSpeech", "voiceEndAnswer", { turnId: "t1" }],
            ["MikeSpeech", "voiceCancelAnswer", { turnId: "t1" }],
            ["MikeSpeech", "voiceStop", undefined],
        ]);
        nativePromise.mockRejectedValue({ code: "failed" });
        voiceSpeak("t1", 2, "x");
        // A step is a clause marked for the engine; it never rejects either.
        voiceSpeakStep("t1", 3, "Reading the lease.");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "voiceSpeak", {
            turnId: "t1",
            clauseId: 3,
            text: "Reading the lease.",
            kind: "step",
        });
        voiceEndAnswer("t1");
        await expect(voiceCancelAnswer("t1")).resolves.toBeUndefined();
        await expect(voiceStop()).resolves.toBeUndefined();
        vi.unstubAllGlobals();
        await expect(voiceStop()).resolves.toBeUndefined();
    });
});

describe("events", () => {
    it("parses every event in the contract and ignores the rest", () => {
        const cases: [unknown, VoiceEvent | null][] = [
            [{ type: "install", fraction: 1.4 }, { type: "install", fraction: 1 }],
            [{ type: "install" }, null],
            [{ type: "state", state: "thinking" }, { type: "state", state: "thinking" }],
            [{ type: "state", state: "dozing" }, null],
            [{ type: "partial", text: "the lease" }, { type: "partial", text: "the lease" }],
            [{ type: "partial" }, null],
            [{ type: "turn", turnId: "t", text: "hi", audioMs: 900 }, { type: "turn", turnId: "t", text: "hi", audioMs: 900 }],
            [{ type: "turn", turnId: "t", text: "hi" }, { type: "turn", turnId: "t", text: "hi", audioMs: 0 }],
            [{ type: "turn", text: "hi" }, null],
            [
                { type: "turn", turnId: "t2", text: "hi there", audioMs: 900, continues: "t1" },
                { type: "turn", turnId: "t2", text: "hi there", audioMs: 900, continues: "t1" },
            ],
            [{ type: "turn", turnId: "t", text: "hi", audioMs: 900, continues: 7 }, { type: "turn", turnId: "t", text: "hi", audioMs: 900 }],
            [{ type: "turn", turnId: "t", text: "hi", audioMs: 900, continues: "" }, { type: "turn", turnId: "t", text: "hi", audioMs: 900 }],
            [{ type: "bargeIn", turnId: "t" }, { type: "bargeIn", turnId: "t" }],
            [{ type: "answerFinished", turnId: "t" }, { type: "answerFinished", turnId: "t" }],
            [{ type: "bargeIn" }, null],
            [{ type: "clauseStarted", turnId: "t", clauseId: 2 }, { type: "clauseStarted", turnId: "t", clauseId: 2 }],
            [{ type: "clausePlayed", turnId: "t", clauseId: 0 }, { type: "clausePlayed", turnId: "t", clauseId: 0 }],
            [{ type: "clausePlayed", turnId: "t", clauseId: -1 }, null],
            [
                { type: "interrupted", turnId: "t", clauseId: 1, fraction: 0.4 },
                { type: "interrupted", turnId: "t", clauseId: 1, fraction: 0.4 },
            ],
            [
                { type: "interrupted", turnId: "t", clauseId: 1 },
                { type: "interrupted", turnId: "t", clauseId: 1, fraction: 0 },
            ],
            [{ type: "interrupted", turnId: "t", clauseId: 1.5 }, null],
            [{ type: "ended", reason: "route" }, { type: "ended", reason: "route" }],
            [{ type: "ended", reason: "mystery" }, { type: "ended", reason: "error" }],
            [
                { type: "metrics", turnId: "t", stages: { finalPass: 30, bad: "x" } },
                { type: "metrics", turnId: "t", stages: { finalPass: 30 } },
            ],
            [{ type: "metrics", stages: {} }, null],
            [{ type: "ignored", reason: "other-voice" }, { type: "ignored", reason: "other-voice" }],
            [{ type: "ignored" }, { type: "ignored", reason: "other-voice" }],
            [
                { type: "preparation", preparing: true, firstTime: true, ready: ["vad"] },
                { type: "preparation", preparing: true, firstTime: true, ready: ["vad"] },
            ],
            [{ type: "preparation" }, { type: "preparation", preparing: false, firstTime: false, ready: [] }],
            [{ type: "unknown" }, null],
            [null, null],
        ];
        for (const [data, event] of cases) expect(parseVoiceEvent(data)).toEqual(event);
    });

    it("shares one bridge listener among every handler, and removes it with the last", () => {
        expect(onVoiceEvent(() => undefined)()).toBeUndefined();
        inApp();
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = onVoiceEvent(first);
        const stopSecond = onVoiceEvent(second);
        expect(addListener).toHaveBeenCalledTimes(1);
        expect(addListener).toHaveBeenCalledWith("MikeSpeech", "voiceEvent", expect.any(Function));
        emit({ type: "partial", text: "rent" });
        emit({ type: "nonsense" });
        expect(first).toHaveBeenCalledWith({ type: "partial", text: "rent" });
        expect(second).toHaveBeenCalledWith({ type: "partial", text: "rent" });
        expect(second).toHaveBeenCalledTimes(1);
        stopFirst();
        stopFirst();
        expect(remove).not.toHaveBeenCalled();
        emit({ type: "partial", text: "due" });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        stopSecond();
        expect(remove).toHaveBeenCalledTimes(1);
        // A new subscriber adds the listener again.
        onVoiceEvent(first)();
        expect(addListener).toHaveBeenCalledTimes(2);
        inApp(["voiceStatus"], false);
        expect(onVoiceEvent(first)).toBeInstanceOf(Function);
    });

    it("survives a bridge that throws or rejects on remove", () => {
        inApp();
        remove.mockImplementationOnce(() => {
            throw new Error("gone");
        });
        onVoiceEvent(() => undefined)();
        remove.mockRejectedValueOnce(new Error("gone"));
        onVoiceEvent(() => undefined)();
        expect(remove).toHaveBeenCalledTimes(2);
    });

    it("explains why voice mode ended", () => {
        expect(endedMessage("stopped")).toBeNull();
        expect(endedMessage("interruption")).toMatch(/call/);
        expect(endedMessage("route")).toMatch(/audio output/);
        expect(endedMessage("error")).toMatch(/problem/);
    });
});
