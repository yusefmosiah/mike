import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primeWebAudio, takePrimedAudio } from "./prime";

class FakeContext {
    static instances: FakeContext[] = [];
    state = "running";
    resume = vi.fn(async () => undefined);
    constructor() {
        FakeContext.instances.push(this);
    }
}

let playMode: "resolve" | "reject" | "sync";
const audios: { src: string; play: ReturnType<typeof vi.fn> }[] = [];
class FakeAudio {
    src = "";
    play = vi.fn(() => {
        if (playMode === "reject") return Promise.reject(new Error("blocked"));
        if (playMode === "sync") return undefined;
        return Promise.resolve();
    });
    constructor() {
        audios.push(this);
    }
}

const speak = vi.fn();
const win = window as unknown as Record<string, unknown>;

beforeEach(() => {
    takePrimedAudio();
    FakeContext.instances = [];
    audios.length = 0;
    playMode = "resolve";
    speak.mockClear();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("SpeechSynthesisUtterance", class { volume = 1; constructor(readonly text: string) {} });
    vi.stubGlobal("AudioContext", FakeContext);
    win.AudioContext = FakeContext;
    win.speechSynthesis = { speak };
    vi.stubGlobal("navigator", { webdriver: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete win.AudioContext;
    delete win.webkitAudioContext;
    delete win.speechSynthesis;
});

describe("primeWebAudio", () => {
    it("creates a context, plays silence on two elements and speaks an empty utterance", () => {
        primeWebAudio();
        const primed = takePrimedAudio();
        expect(primed?.context).toBe(FakeContext.instances[0]);
        expect(FakeContext.instances[0].resume).toHaveBeenCalled();
        expect(primed?.elements).toHaveLength(2);
        for (const audio of audios) {
            expect(audio.src).not.toBe("");
            expect(audio.play).toHaveBeenCalled();
        }
        expect(speak).toHaveBeenCalledTimes(1);
        expect(takePrimedAudio()).toBeNull();
    });

    it("reuses a live primed context and its elements, but replaces a closed context", () => {
        primeWebAudio();
        const first = FakeContext.instances[0];
        primeWebAudio();
        expect(FakeContext.instances).toHaveLength(1);
        expect(audios).toHaveLength(2);
        expect(first.resume).toHaveBeenCalledTimes(2);

        first.state = "closed";
        primeWebAudio();
        expect(FakeContext.instances).toHaveLength(2);
        expect(takePrimedAudio()?.context).toBe(FakeContext.instances[1]);
    });

    it("falls back to webkitAudioContext, and to no context at all", () => {
        delete win.AudioContext;
        win.webkitAudioContext = FakeContext;
        primeWebAudio();
        expect(FakeContext.instances).toHaveLength(1);
        takePrimedAudio();

        delete win.webkitAudioContext;
        primeWebAudio();
        expect(takePrimedAudio()?.context).toBeNull();
    });

    it("survives a rejecting resume, a rejecting play and a play that returns nothing", async () => {
        class Rejecting extends FakeContext {
            resume = vi.fn(() => Promise.reject(new Error("no")));
        }
        win.AudioContext = Rejecting;
        playMode = "reject";
        primeWebAudio();
        playMode = "sync";
        takePrimedAudio();
        primeWebAudio();
        await Promise.resolve();
        expect(takePrimedAudio()).not.toBeNull();
    });

    it("skips the system voice under automation or without speech synthesis", () => {
        vi.stubGlobal("navigator", { webdriver: true });
        primeWebAudio();
        expect(speak).not.toHaveBeenCalled();
        takePrimedAudio();

        vi.stubGlobal("navigator", { webdriver: false });
        delete win.speechSynthesis;
        primeWebAudio();
        takePrimedAudio();

        win.speechSynthesis = { speak };
        vi.stubGlobal("SpeechSynthesisUtterance", undefined);
        primeWebAudio();
        expect(speak).not.toHaveBeenCalled();
    });

    it("never throws when the browser does", () => {
        vi.stubGlobal("Audio", class { constructor() { throw new Error("no audio"); } });
        expect(() => primeWebAudio()).not.toThrow();
        expect(takePrimedAudio()).toBeNull();
    });

    it("does nothing without a window", () => {
        vi.stubGlobal("window", undefined);
        expect(() => primeWebAudio()).not.toThrow();
        vi.unstubAllGlobals();
        expect(takePrimedAudio()).toBeNull();
    });
});
