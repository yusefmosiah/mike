import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceEvent } from "./voiceEngine";

/**
 * voiceEngine.ts in a browser: the same functions dispatch to the web engine
 * (mocked here), which is imported only on first use; the app's native
 * engine wins wherever its plugin is present.
 */

const support = vi.hoisted(() => ({ value: true }));
vi.mock("./web/support", () => ({ webVoiceSupported: () => support.value }));

const prime = vi.hoisted(() => vi.fn());
vi.mock("./web/prime", () => ({ primeWebAudio: prime }));

const created = vi.hoisted(() => ({ count: 0 }));
const engine = vi.hoisted(() => ({
    emit: null as ((event: unknown) => void) | null,
    status: vi.fn(),
    install: vi.fn(),
    remove: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    speak: vi.fn(),
    endAnswer: vi.fn(),
    cancelAnswer: vi.fn(),
}));
vi.mock("./web/webBackend", () => ({
    WebVoiceBackend: class {
        constructor(emit: (event: unknown) => void) {
            created.count += 1;
            engine.emit = emit;
            return engine;
        }
    },
}));

async function load() {
    vi.resetModules();
    return import("./voiceEngine");
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    support.value = true;
    created.count = 0;
    prime.mockClear();
    for (const fn of Object.values(engine)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
    engine.status.mockResolvedValue({ available: true, missing: [], downloadBytes: 0, speakerLearned: false, preparing: false, firstTime: false, ready: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe("voiceEngine in a browser", () => {
    it("offers voice mode where the browser can run it, and not inside an app without the native engine", async () => {
        const voice = await load();
        expect(voice.backend()).toBe("web");
        expect(voice.voiceChatSupported()).toBe(true);
        expect(voice.voiceMicrophoneModesSupported()).toBe(false);
        expect(voice.voiceForgetSpeakerSupported()).toBe(false);
        support.value = false;
        expect(voice.voiceChatSupported()).toBe(false);
        support.value = true;
        // The Android app: the shell is there, the engine is not.
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech", methods: [] }], nativePromise: vi.fn() });
        expect(voice.backend()).toBeNull();
    });

    it("prefers the native engine where the plugin has it", async () => {
        const nativePromise = vi.fn(async () => ({ available: true }));
        vi.stubGlobal("Capacitor", {
            PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "voiceStatus" }] }],
            nativePromise,
            addListener: vi.fn(() => ({ remove: vi.fn() })),
        });
        const voice = await load();
        expect(voice.backend()).toBe("native");
        voice.voicePrime();
        expect(prime).not.toHaveBeenCalled();
        await voice.voiceStatus();
        await voice.voiceStart({ config: {} });
        voice.voiceSpeak("t1", 0, "Hello.");
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceStatus", undefined);
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceStart", { config: {} });
        expect(created.count).toBe(0);
    });

    it("loads the web engine only when voice mode is used, and nothing before", async () => {
        const voice = await load();
        voice.voiceSpeak("t1", 0, "Hello.");
        voice.voiceEndAnswer("t1");
        await voice.voiceCancelAnswer("t1");
        await voice.voiceStop();
        voice.voicePrewarm();
        await flush();
        expect(created.count).toBe(0);
        voice.voicePrime();
        expect(prime).toHaveBeenCalledTimes(1);
        expect(created.count).toBe(0);
        expect((await voice.voiceStatus()).available).toBe(true);
        expect(created.count).toBe(1);
    });

    it("dispatches every call to the web engine and hands its events to every handler", async () => {
        const voice = await load();
        const heard: VoiceEvent[] = [];
        const off = voice.onVoiceEvent((event) => heard.push(event));
        engine.install.mockResolvedValue(true);
        expect(await voice.voiceInstall()).toBe(true);
        await voice.voiceStart({ config: { fallbackSilenceMs: 700 }, voice: "Harper" });
        expect(engine.start).toHaveBeenCalledWith({ fallbackSilenceMs: 700 }, "Harper");
        voice.voiceSpeak("t1", 0, "Hello.", true);
        voice.voiceSpeakStep("t1", 1, "Reading the lease.");
        voice.voiceEndAnswer("t1");
        await voice.voiceCancelAnswer("t1");
        await flush();
        expect(engine.speak).toHaveBeenNthCalledWith(1, "t1", 0, "Hello.", false);
        expect(engine.speak).toHaveBeenNthCalledWith(2, "t1", 1, "Reading the lease.", true);
        expect(engine.endAnswer).toHaveBeenCalledWith("t1");
        expect(engine.cancelAnswer).toHaveBeenCalledWith("t1");
        engine.emit?.({ type: "state", state: "speaking" });
        expect(heard).toEqual([{ type: "state", state: "speaking" }]);
        off();
        engine.emit?.({ type: "state", state: "listening" });
        expect(heard).toHaveLength(1);
        await voice.voiceStop();
        expect(engine.stop).toHaveBeenCalled();
    });

    it("words the web engine's failures for a browser", async () => {
        const voice = await load();
        engine.start.mockRejectedValueOnce({ code: "permission-denied" });
        await expect(voice.voiceStart({ config: {} })).rejects.toMatchObject({
            message: voice.WEB_VOICE_MICROPHONE_MESSAGE,
            code: "permission-denied",
        });
        engine.start.mockRejectedValueOnce({ code: "no-microphone" });
        await expect(voice.voiceStart({ config: {} })).rejects.toMatchObject({ message: voice.WEB_VOICE_NO_MICROPHONE_MESSAGE });
        engine.start.mockRejectedValueOnce({ code: "cancelled" });
        await expect(voice.voiceStart({ config: {} })).rejects.toMatchObject({ code: "cancelled" });
        engine.remove.mockRejectedValueOnce({ code: "busy" });
        await expect(voice.voiceRemove()).rejects.toMatchObject({ message: voice.VOICE_BUSY_MESSAGE });
        engine.status.mockRejectedValueOnce(new Error("broken"));
        expect((await voice.voiceStatus()).available).toBe(false);
        expect(voice.voiceUnavailableMessage()).toBe(voice.WEB_VOICE_UNAVAILABLE_MESSAGE);
        expect(voice.endedMessage("route")).toMatch(/microphone/);
        // Nothing in the browser wording mentions a phone.
        for (const message of [voice.WEB_VOICE_MICROPHONE_MESSAGE, voice.WEB_VOICE_NO_MICROPHONE_MESSAGE, voice.WEB_VOICE_UNAVAILABLE_MESSAGE]) {
            expect(message).not.toMatch(/\bphone\b|iPhone/i);
        }
    });
});
