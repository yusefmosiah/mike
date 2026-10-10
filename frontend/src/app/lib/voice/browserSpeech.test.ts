import { afterEach, describe, expect, it, vi } from "vitest";

import {
    BrowserRecognitionError,
    browserSpeechSupported,
    browserVoices,
    defaultSpeechLanguage,
    installOnDeviceRecognition,
    onDeviceRecognitionStatus,
    speakWithBrowser,
    startOnDeviceRecognition,
} from "./browserSpeech";

type Handler<T> = ((event: T) => void) | null;

/** A Web Speech recognition double that records what the module sets. */
class FakeRecognition {
    static instances: FakeRecognition[] = [];
    lang = "";
    continuous = false;
    interimResults = true;
    processLocally = false;
    onresult: Handler<{ resultIndex: number; results: unknown }> = null;
    onerror: Handler<{ error: string }> = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
        FakeRecognition.instances.push(this);
    }
}

function results(...items: Array<[string, boolean]>) {
    return Object.assign(
        items.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
        { length: items.length },
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    FakeRecognition.instances = [];
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

describe("defaultSpeechLanguage", () => {
    it("uses the browser language, or en-US without one", () => {
        vi.stubGlobal("navigator", { language: "fr-FR" });
        expect(defaultSpeechLanguage()).toBe("fr-FR");
        vi.stubGlobal("navigator", { language: "" });
        expect(defaultSpeechLanguage()).toBe("en-US");
        vi.stubGlobal("navigator", undefined);
        expect(defaultSpeechLanguage()).toBe("en-US");
    });
});

describe("on-device recognition status and install", () => {
    it("is unavailable without the API, without available(), or outside a browser", async () => {
        expect(await onDeviceRecognitionStatus("en-US")).toBe("unavailable");
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
        expect(await onDeviceRecognitionStatus("en-US")).toBe("unavailable");
        expect(await installOnDeviceRecognition("en-US")).toBe(false);
        vi.stubGlobal("window", undefined);
        expect(await onDeviceRecognitionStatus("en-US")).toBe("unavailable");
    });

    it("asks for on-device processing and reports what the browser says", async () => {
        const available = vi.fn().mockResolvedValue("downloadable");
        const install = vi.fn().mockResolvedValue(true);
        (window as unknown as Record<string, unknown>).SpeechRecognition = Object.assign(FakeRecognition, { available, install });
        expect(await onDeviceRecognitionStatus("de-DE")).toBe("downloadable");
        expect(available).toHaveBeenCalledWith({ langs: ["de-DE"], processLocally: true });
        expect(await installOnDeviceRecognition("de-DE")).toBe(true);
        expect(install).toHaveBeenCalledWith({ langs: ["de-DE"], processLocally: true });
        Object.assign(FakeRecognition, { available: undefined, install: undefined });
    });

    it("treats a throwing browser as unavailable and a failed install as false", async () => {
        const Ctor = Object.assign(class extends FakeRecognition {}, {
            available: vi.fn().mockRejectedValue(new Error("boom")),
            install: vi.fn().mockRejectedValue(new Error("boom")),
        });
        (window as unknown as Record<string, unknown>).SpeechRecognition = Ctor;
        expect(await onDeviceRecognitionStatus()).toBe("unavailable");
        expect(await installOnDeviceRecognition()).toBe(false);
    });
});

describe("startOnDeviceRecognition", () => {
    it("refuses without the API or without on-device processing", () => {
        expect(() => startOnDeviceRecognition("en-US")).toThrow(BrowserRecognitionError);
        class CloudOnly {
            start = vi.fn();
        }
        (window as unknown as Record<string, unknown>).SpeechRecognition = CloudOnly;
        expect(() => startOnDeviceRecognition("en-US")).toThrow("not available in this browser");
    });

    it("listens locally and resolves with the final results on stop", async () => {
        (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
        const session = startOnDeviceRecognition("en-GB");
        const rec = FakeRecognition.instances[0];
        expect(rec).toMatchObject({ processLocally: true, lang: "en-GB", continuous: true, interimResults: false });
        expect(rec.start).toHaveBeenCalled();
        rec.onresult?.({ resultIndex: 0, results: results([" hello ", true], ["draft", false]) });
        rec.onresult?.({ resultIndex: 2, results: results(["x", true], ["y", true], ["world", true]) });
        rec.onerror?.({ error: "no-speech" });
        rec.onerror?.({ error: "aborted" });
        const done = session.stop();
        expect(rec.stop).toHaveBeenCalled();
        rec.onend?.();
        await expect(done).resolves.toBe("hello world");
    });

    it("rejects with a plain message for a known or unknown error", async () => {
        (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
        const denied = startOnDeviceRecognition("en-US");
        FakeRecognition.instances[0].onerror?.({ error: "not-allowed" });
        const deniedResult = denied.stop();
        FakeRecognition.instances[0].onend?.();
        await expect(deniedResult).rejects.toThrow("Microphone access denied");

        const odd = startOnDeviceRecognition("en-US");
        FakeRecognition.instances[1].onerror?.({ error: "network" });
        const oddResult = odd.stop();
        FakeRecognition.instances[1].onend?.();
        await expect(oddResult).rejects.toThrow("Could not recognise speech");
    });

    it("cancel aborts and settles nothing", () => {
        (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
        const session = startOnDeviceRecognition("en-US");
        const rec = FakeRecognition.instances[0];
        session.cancel();
        expect(rec.abort).toHaveBeenCalled();
        rec.onerror?.({ error: "network" });
        expect(() => rec.onend?.()).not.toThrow();
        const quiet = startOnDeviceRecognition("en-US");
        quiet.cancel();
        expect(() => FakeRecognition.instances[1].onend?.()).not.toThrow();
    });
});

type Utterance = {
    text: string;
    voice?: unknown;
    rate?: number;
    onend?: () => void;
    onerror?: (event: { error: string }) => void;
};

function stubSynthesis(voices: Array<{ voiceURI: string }>) {
    const listeners = new Map<string, () => void>();
    const spoken: Utterance[] = [];
    const synth = {
        getVoices: vi.fn(() => voices),
        speak: vi.fn((u: Utterance) => spoken.push(u)),
        addEventListener: vi.fn((name: string, fn: () => void) => listeners.set(name, fn)),
        removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    };
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal(
        "SpeechSynthesisUtterance",
        class {
            text: string;
            constructor(text: string) {
                this.text = text;
            }
        },
    );
    return { synth, spoken, listeners };
}

describe("browser speech synthesis", () => {
    it("is unsupported without speechSynthesis or outside a browser", async () => {
        vi.stubGlobal("SpeechSynthesisUtterance", undefined);
        expect(browserSpeechSupported()).toBe(false);
        expect(await browserVoices()).toEqual([]);
        await expect(speakWithBrowser("hi")).rejects.toThrow("cannot read aloud");
        vi.stubGlobal("window", undefined);
        expect(browserSpeechSupported()).toBe(false);
    });

    it("returns the voices at once when the list is ready", async () => {
        const { synth } = stubSynthesis([{ voiceURI: "a" }]);
        expect(browserSpeechSupported()).toBe(true);
        expect(await browserVoices()).toEqual([{ voiceURI: "a" }]);
        expect(synth.addEventListener).not.toHaveBeenCalled();
    });

    it("waits for voiceschanged, or for the timeout", async () => {
        const voices: Array<{ voiceURI: string }> = [];
        const { listeners, synth } = stubSynthesis(voices);
        const pending = browserVoices(10_000);
        voices.push({ voiceURI: "late" });
        listeners.get("voiceschanged")?.();
        expect(await pending).toEqual([{ voiceURI: "late" }]);
        expect(synth.removeEventListener).toHaveBeenCalled();

        vi.useFakeTimers();
        const empty = stubSynthesis([]);
        const timed = browserVoices(50);
        vi.advanceTimersByTime(60);
        expect(await timed).toEqual([]);
        expect(empty.synth.removeEventListener).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("speaks with the chosen voice and rate and resolves at the end", async () => {
        const voice = { voiceURI: "chosen" };
        const { spoken } = stubSynthesis([{ voiceURI: "other" }, voice]);
        const done = speakWithBrowser("Hello", { voiceURI: "chosen", rate: 1.5 });
        expect(spoken[0]).toMatchObject({ text: "Hello", voice, rate: 1.5 });
        spoken[0].onend?.();
        await expect(done).resolves.toBeUndefined();

        const missing = speakWithBrowser("Again", { voiceURI: "gone" });
        expect(spoken[1].voice).toBeUndefined();
        expect(spoken[1].rate).toBeUndefined();
        spoken[1].onend?.();
        await missing;
    });

    it("treats cancelling as the end and other errors as failures", async () => {
        const { spoken } = stubSynthesis([]);
        const canceled = speakWithBrowser("a");
        spoken[0].onerror?.({ error: "canceled" });
        await expect(canceled).resolves.toBeUndefined();
        const interrupted = speakWithBrowser("b");
        spoken[1].onerror?.({ error: "interrupted" });
        await expect(interrupted).resolves.toBeUndefined();
        const failed = speakWithBrowser("c");
        spoken[2].onerror?.({ error: "synthesis-failed" });
        await expect(failed).rejects.toThrow("Playback failed.");
    });
});
