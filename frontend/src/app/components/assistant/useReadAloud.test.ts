import { brand } from "@/app/lib/brand";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeSpeech } from "@/app/lib/mikeApi";
import { BrowserModelError } from "@/app/lib/voice/browserModels";
import { saveVoicePreferences } from "@/app/lib/voice/preferences";
import {
    MAX_READ_ALOUD_SENTENCES,
    splitIntoReadAloudSentences,
    useReadAloud,
} from "./useReadAloud";
import { readAloudTitle } from "./readAloudShared";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    synthesizeSpeech: vi.fn(),
}));

const synthesizeMock = vi.mocked(synthesizeSpeech);

class MockAudio {
    src = "";
    preload = "";
    playbackRate = 1;
    currentTime = 0;
    duration = Number.NaN;
    ended = false;
    onplay: (() => void) | null = null;
    onpause: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    ondurationchange: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn((): Promise<void> => Promise.resolve());
    pause = vi.fn();
    removeAttribute = vi.fn((name: string) => {
        if (name === "src") this.src = "";
    });

    constructor() {
        audioInstances.push(this);
    }
}

const audioInstances: MockAudio[] = [];
const audio = () => audioInstances[0]!;

/** Decodes every file to one second of silence at the render rate. */
class MockOfflineAudioContext {
    decodeAudioData(_bytes: ArrayBuffer, ok: (buffer: AudioBuffer) => void) {
        ok({ numberOfChannels: 1, length: 24_000, getChannelData: () => new Float32Array(24_000) } as unknown as AudioBuffer);
    }
}

let urlCounter = 0;
const createObjectURLMock = vi.fn<(blob: Blob) => string>(() => `blob:test-${++urlCounter}`);
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
    audioInstances.length = 0;
    urlCounter = 0;
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    synthesizeMock.mockReset();
    synthesizeMock.mockImplementation(async (text: string) => new Blob([text], { type: "audio/mpeg" }));
    Object.assign(URL, { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock });
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
    window.localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function startReading(text = "First sentence. Second sentence.") {
    const hook = renderHook(({ text }: { text: string }) => useReadAloud(text), { initialProps: { text } });
    act(() => hook.result.current.play());
    await waitFor(() => expect(hook.result.current.status).toBe("playing"));
    return hook;
}

describe("splitIntoReadAloudSentences", () => {
    it("splits on sentence punctuation", () => {
        expect(splitIntoReadAloudSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
    });

    it("falls back to the whole text when there is no punctuation", () => {
        expect(splitIntoReadAloudSentences("no punctuation here")).toEqual(["no punctuation here"]);
    });

    it("returns nothing for blank text", () => {
        expect(splitIntoReadAloudSentences("   ")).toEqual([]);
    });

    it("caps the queue at the sentence limit", () => {
        const text = Array.from({ length: MAX_READ_ALOUD_SENTENCES + 5 }, (_, i) => `S${i}.`).join(" ");
        expect(splitIntoReadAloudSentences(text)).toHaveLength(MAX_READ_ALOUD_SENTENCES);
    });
});

describe("readAloudTitle", () => {
    it("is the first sentence, shortened", () => {
        expect(readAloudTitle("Short one. Then more.")).toBe("Short one.");
        expect(readAloudTitle(`${"word ".repeat(30)}end.`)).toMatch(/^word word.*…$/);
        expect(readAloudTitle("")).toBe("");
    });
});

describe("useReadAloud with synthesized audio", () => {
    it("renders the whole response into one file and plays it", async () => {
        const { result } = renderHook(() => useReadAloud("First sentence. Second sentence."));
        expect(result.current.available).toBe(true);
        expect(result.current.unit).toBe("seconds");

        act(() => result.current.play());
        expect(result.current.status).toBe("preparing");
        // The tap plays a moment of silence first, so iOS allows the real audio later.
        expect(audio().src).toBe("blob:test-1");
        expect(audio().play).toHaveBeenCalledTimes(1);

        await waitFor(() => expect(result.current.status).toBe("playing"));
        // One synthesis call for the whole short response, not one per sentence.
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(synthesizeMock).toHaveBeenCalledWith("First sentence. Second sentence.");
        expect(createObjectURLMock.mock.calls[1]?.[0].type).toBe("audio/wav");
        expect(audio().src).toBe("blob:test-2");
        expect(audio().play).toHaveBeenCalledTimes(2);
    });

    it("splits a long response into chunks synthesized a few at a time", async () => {
        const sentence = `${"word ".repeat(60).trim()}.`;
        await startReading(Array.from({ length: 10 }, () => sentence).join(" "));
        // 300 characters a sentence, at most 1,200 a chunk: three sentences per call.
        expect(synthesizeMock).toHaveBeenCalledTimes(4);
    });

    it("follows the element: position, length, pause, resume and the end", async () => {
        const { result } = await startReading();
        const element = audio();

        element.duration = 10;
        element.currentTime = 3;
        act(() => {
            element.ondurationchange?.();
            element.ontimeupdate?.();
        });
        expect(result.current.length).toBe(10);
        expect(result.current.position).toBe(3);

        act(() => result.current.pause());
        expect(element.pause).toHaveBeenCalled();
        expect(result.current.status).toBe("paused");
        act(() => element.onpause?.());
        expect(result.current.status).toBe("paused");

        act(() => result.current.resume());
        expect(result.current.status).toBe("playing");
        act(() => element.onplay?.());
        expect(element.play).toHaveBeenCalledTimes(3);

        element.ended = true;
        act(() => element.onended?.());
        expect(result.current.status).toBe("idle");
        expect(result.current.position).toBe(0);
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-2");
    });

    it("ignores a length the element does not know yet", async () => {
        const { result } = await startReading();
        act(() => audio().ondurationchange?.());
        expect(result.current.length).toBe(0);
    });

    it("seeks within the file, clamped to its length", async () => {
        const { result } = await startReading();
        audio().duration = 10;
        act(() => result.current.seek(4));
        expect(audio().currentTime).toBe(4);
        expect(result.current.position).toBe(4);
        act(() => result.current.seek(99));
        expect(audio().currentTime).toBe(10);
        act(() => result.current.seek(-1));
        expect(audio().currentTime).toBe(0);
    });

    it("seeks to where it was asked while the length is unknown", async () => {
        const { result } = await startReading();
        act(() => result.current.seek(7));
        expect(audio().currentTime).toBe(7);
    });

    it("does nothing to pause, resume or seek before anything plays", () => {
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => {
            result.current.pause();
            result.current.resume();
            result.current.seek(3);
        });
        expect(result.current.status).toBe("idle");
        expect(audioInstances).toHaveLength(0);
    });

    it("applies the speed to the element now and on the next play", async () => {
        const { result } = await startReading();
        act(() => result.current.setSpeed(1.5));
        expect(result.current.speed).toBe(1.5);
        expect(audio().playbackRate).toBe(1.5);
    });

    it("keeps the file, so playing again does not synthesize again", async () => {
        const { result } = await startReading();
        act(() => result.current.stop());
        expect(result.current.status).toBe("idle");
        expect(audio().pause).toHaveBeenCalled();

        act(() => result.current.play());
        expect(result.current.status).toBe("playing");
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(audio().src).toBe("blob:test-3");
    });

    it("stopping while it prepares abandons the audio", async () => {
        let finish: (blob: Blob) => void = () => {};
        synthesizeMock.mockImplementation(() => new Promise<Blob>((resolve) => (finish = resolve)));
        const { result } = renderHook(() => useReadAloud("One. Two."));
        act(() => result.current.play());
        act(() => result.current.stop());
        await act(async () => finish(new Blob(["x"])));
        expect(result.current.status).toBe("idle");
        expect(result.current.error).toBeNull();
        expect(createObjectURLMock).toHaveBeenCalledTimes(1); // the silence only
    });

    it("shows a plain message when synthesis fails", async () => {
        synthesizeMock.mockRejectedValueOnce(new Error("upstream said something internal"));
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        await waitFor(() => expect(result.current.error).toBe("Could not read this response aloud."));
        expect(result.current.status).toBe("idle");
    });

    it("shows the open model's own message", async () => {
        synthesizeMock.mockRejectedValueOnce(new BrowserModelError("The open model could not run."));
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        await waitFor(() => expect(result.current.error).toBe("The open model could not run."));
    });

    it("says so when the browser refuses to play", async () => {
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        audio().play.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
        await waitFor(() => expect(result.current.error).toBe("The browser did not allow playback. Tap play again."));
    });

    it("reports a resume the browser refuses, and an element error", async () => {
        const { result } = await startReading();
        act(() => result.current.pause());
        audio().play.mockRejectedValueOnce(new Error("nope"));
        act(() => result.current.resume());
        await waitFor(() => expect(result.current.error).toBe("Could not read this response aloud."));

        act(() => result.current.play());
        await waitFor(() => expect(result.current.status).toBe("playing"));
        act(() => audio().onerror?.());
        expect(result.current.error).toBe("Playback failed.");
    });

    it("offers lock-screen controls through the Media Session API", async () => {
        const handlers = new Map<string, MediaSessionActionHandler | null>();
        const session = {
            metadata: null as unknown,
            setActionHandler: vi.fn((action: string, handler: MediaSessionActionHandler | null) => handlers.set(action, handler)),
        };
        vi.stubGlobal("navigator", { ...navigator, mediaSession: session });
        vi.stubGlobal(
            "MediaMetadata",
            class {
                constructor(public init: { title: string; artist: string }) {}
            },
        );
        const { result } = await startReading("Lock screen title. More.");
        expect(session.metadata).toMatchObject({ init: { title: "Lock screen title.", artist: brand.name } });

        const run = (action: string, details: Partial<MediaSessionActionDetails> = {}) =>
            act(() => handlers.get(action)?.({ action, ...details } as MediaSessionActionDetails));
        audio().duration = 60;
        run("seekto", { seekTime: 20 });
        expect(audio().currentTime).toBe(20);
        run("seekto");
        expect(audio().currentTime).toBe(0);
        audio().currentTime = 20;
        run("seekforward");
        expect(audio().currentTime).toBe(30);
        run("seekbackward");
        expect(audio().currentTime).toBe(20);
        run("pause");
        expect(result.current.status).toBe("paused");
        run("play");
        expect(result.current.status).toBe("playing");
        run("stop");
        expect(result.current.status).toBe("idle");
        expect(session.metadata).toBeNull();
    });

    it("keeps working when the browser rejects a media session action", async () => {
        vi.stubGlobal("navigator", {
            ...navigator,
            mediaSession: {
                metadata: null,
                setActionHandler: () => {
                    throw new TypeError("unknown action");
                },
            },
        });
        const { result } = await startReading();
        expect(result.current.status).toBe("playing");
    });

    it("does nothing when there is no prose to read", () => {
        const { result } = renderHook(() => useReadAloud("   "));
        expect(result.current.available).toBe(false);
        act(() => result.current.play());
        expect(result.current.status).toBe("idle");
        expect(synthesizeMock).not.toHaveBeenCalled();
    });

    it("stops and drops the file when the prose changes", async () => {
        const { result, rerender } = await startReading("One. Two.");
        rerender({ text: "Three. Four." });
        await waitFor(() => expect(result.current.status).toBe("idle"));
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-2");

        act(() => result.current.play());
        await waitFor(() => expect(result.current.status).toBe("playing"));
        expect(synthesizeMock).toHaveBeenLastCalledWith("Three. Four.");
    });

    it("clears an error when the prose changes", async () => {
        synthesizeMock.mockRejectedValueOnce(new Error("x"));
        const { result, rerender } = renderHook(({ text }: { text: string }) => useReadAloud(text), {
            initialProps: { text: "One." },
        });
        act(() => result.current.play());
        await waitFor(() => expect(result.current.error).not.toBeNull());
        rerender({ text: "One. Two." });
        await waitFor(() => expect(result.current.error).toBeNull());
    });

    it("leaves idle state alone while streamed prose grows", () => {
        let renders = 0;
        const { result, rerender } = renderHook(
            ({ text }: { text: string }) => {
                renders += 1;
                return useReadAloud(text);
            },
            { initialProps: { text: "One." } },
        );
        const before = renders;
        for (const text of ["One. Two", "One. Two.", "One. Two. Three."]) rerender({ text });
        expect(renders - before).toBe(3);
        expect(result.current.status).toBe("idle");
        expect(revokeObjectURLMock).not.toHaveBeenCalled();
    });

    it("silences the message and frees the silence when it unmounts", async () => {
        const { unmount } = await startReading();
        unmount();
        expect(audio().pause).toHaveBeenCalled();
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-1");
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-2");
    });
});

/** speechSynthesis that records what it was asked to say. */
class FakeUtterance {
    voice: SpeechSynthesisVoice | null = null;
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    constructor(public text: string) {}
}

function stubSpeech() {
    const spoken: FakeUtterance[] = [];
    const synth = {
        speaking: false,
        pending: false,
        paused: false,
        speak: vi.fn((utterance: FakeUtterance) => {
            spoken.push(utterance);
            synth.speaking = true;
        }),
        cancel: vi.fn(() => {
            synth.speaking = false;
        }),
        pause: vi.fn(),
        resume: vi.fn(),
        getVoices: () => [{ voiceURI: "v-fr" }] as SpeechSynthesisVoice[],
    };
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    return { synth, spoken };
}

describe("useReadAloud with the browser's voices", () => {
    beforeEach(() => {
        saveVoicePreferences({ transcription: { engine: "operator" }, speech: { engine: "browser", voice: "v-fr" } });
    });

    it("queues every sentence inside the tap, with the chosen voice", () => {
        const { synth, spoken } = stubSpeech();
        const { result } = renderHook(() => useReadAloud("One. Two."));
        expect(result.current.unit).toBe("sentences");
        expect(result.current.length).toBe(2);

        act(() => result.current.play());
        expect(synth.cancel).not.toHaveBeenCalled();
        expect(spoken.map((u) => u.text)).toEqual(["One.", "Two."]);
        expect(spoken[0].voice).toEqual({ voiceURI: "v-fr" });
        expect(result.current.status).toBe("playing");

        act(() => spoken[1].onstart?.());
        expect(result.current.position).toBe(1);
        act(() => spoken[0].onend?.());
        expect(result.current.status).toBe("playing");
        act(() => spoken[1].onend?.());
        expect(result.current.status).toBe("idle");
        expect(result.current.position).toBe(0);
    });

    it("uses the default voice when the chosen one is missing", () => {
        saveVoicePreferences({ transcription: { engine: "operator" }, speech: { engine: "browser", voice: "gone" } });
        const { spoken } = stubSpeech();
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        expect(spoken[0].voice).toBeNull();
    });

    it("seeks by sentence: cancels, waits a moment, then queues from there", () => {
        vi.useFakeTimers();
        try {
            const { synth, spoken } = stubSpeech();
            const { result } = renderHook(() => useReadAloud("One. Two. Three."));
            act(() => result.current.play());
            act(() => result.current.seek(2));
            expect(synth.cancel).toHaveBeenCalled();
            expect(spoken).toHaveLength(3);
            act(() => vi.advanceTimersByTime(150));
            expect(spoken.slice(3).map((u) => u.text)).toEqual(["Three."]);
            expect(result.current.position).toBe(2);
            // A cancelled sentence's events no longer move the reading.
            act(() => spoken[0].onstart?.());
            expect(result.current.position).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("re-queues at the new speed", () => {
        vi.useFakeTimers();
        try {
            const { spoken } = stubSpeech();
            const { result } = renderHook(() => useReadAloud("One. Two."));
            act(() => result.current.setSpeed(1.25));
            act(() => result.current.play());
            expect(spoken[0].rate).toBe(1.25);
            act(() => result.current.setSpeed(1.5));
            act(() => vi.advanceTimersByTime(150));
            expect(spoken.at(-1)?.rate).toBe(1.5);
        } finally {
            vi.useRealTimers();
        }
    });

    it("pauses and resumes the voice", () => {
        const { synth } = stubSpeech();
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.pause());
        expect(synth.pause).not.toHaveBeenCalled();
        act(() => result.current.play());
        act(() => result.current.pause());
        expect(synth.pause).toHaveBeenCalled();
        expect(result.current.status).toBe("paused");
        synth.paused = true;
        act(() => result.current.resume());
        expect(synth.resume).toHaveBeenCalled();
        expect(result.current.status).toBe("playing");
        act(() => result.current.seek(0));
        expect(synth.resume).toHaveBeenCalledTimes(2);
    });

    it("reports a voice error but not a cancellation", () => {
        const { spoken } = stubSpeech();
        const { result } = renderHook(() => useReadAloud("One. Two."));
        act(() => result.current.play());
        act(() => spoken[0].onerror?.({ error: "interrupted" }));
        act(() => spoken[0].onerror?.({ error: "canceled" }));
        expect(result.current.error).toBeNull();
        act(() => spoken[0].onerror?.({ error: "synthesis-failed" }));
        expect(result.current.error).toBe("Playback failed.");
        expect(result.current.status).toBe("idle");
        act(() => spoken[1].onerror?.({ error: "synthesis-failed" }));
        expect(result.current.status).toBe("idle");
    });

    it("stops, and says so when the browser has no voices", () => {
        const { synth } = stubSpeech();
        const { result } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        act(() => result.current.stop());
        expect(synth.cancel).toHaveBeenCalled();
        expect(result.current.status).toBe("idle");
        act(() => result.current.seek(0));
        expect(result.current.status).toBe("idle");

        vi.stubGlobal("speechSynthesis", undefined);
        Reflect.deleteProperty(window, "speechSynthesis");
        act(() => result.current.play());
        expect(result.current.error).toBe("This browser cannot read aloud.");
    });

    it("does nothing with no prose, and silences the voice on unmount", () => {
        const { synth, spoken } = stubSpeech();
        const empty = renderHook(() => useReadAloud(" "));
        act(() => empty.result.current.play());
        expect(spoken).toHaveLength(0);

        const { result, unmount } = renderHook(() => useReadAloud("One."));
        act(() => result.current.play());
        unmount();
        expect(synth.cancel).toHaveBeenCalled();
    });
});
