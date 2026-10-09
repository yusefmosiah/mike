import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeSpeech } from "@/app/lib/mikeApi";
import {
    MAX_READ_ALOUD_SENTENCES,
    splitIntoReadAloudSentences,
    useReadAloud,
} from "./useReadAloud";

vi.mock("@/app/lib/mikeApi", () => ({
    synthesizeSpeech: vi.fn(),
}));

const synthesizeMock = vi.mocked(synthesizeSpeech);

class MockAudio {
    src = "";
    preload = "";
    playbackRate = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    removeAttribute = vi.fn((name: string) => {
        if (name === "src") this.src = "";
    });

    constructor() {
        audioInstances.push(this);
    }
}

const audioInstances: MockAudio[] = [];

let urlCounter = 0;
const createObjectURLMock = vi.fn(() => `blob:test-${++urlCounter}`);
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
    audioInstances.length = 0;
    urlCounter = 0;
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    synthesizeMock.mockReset();
    synthesizeMock.mockImplementation(
        async (text: string) => new Blob([text], { type: "audio/mpeg" }),
    );
    Object.assign(URL, {
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
    });
    vi.stubGlobal("Audio", MockAudio);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("splitIntoReadAloudSentences", () => {
    it("splits on sentence punctuation", () => {
        expect(
            splitIntoReadAloudSentences("One. Two! Three? Four"),
        ).toEqual(["One.", "Two!", "Three?", "Four"]);
    });

    it("falls back to the whole text when there is no punctuation", () => {
        expect(splitIntoReadAloudSentences("no punctuation at all")).toEqual([
            "no punctuation at all",
        ]);
    });

    it("returns nothing for blank text", () => {
        expect(splitIntoReadAloudSentences("   \n  ")).toEqual([]);
    });

    it("caps the queue at the sentence limit", () => {
        const text = Array.from(
            { length: MAX_READ_ALOUD_SENTENCES + 25 },
            (_, i) => `Sentence ${i}.`,
        ).join(" ");
        expect(splitIntoReadAloudSentences(text)).toHaveLength(
            MAX_READ_ALOUD_SENTENCES,
        );
    });
});

describe("useReadAloud", () => {
    it("plays sentence by sentence and finishes after the last one", async () => {
        const { result } = renderHook(() => useReadAloud("One. Two."));

        expect(result.current.sentenceCount).toBe(2);
        expect(result.current.playing).toBe(false);

        await act(async () => {
            result.current.play();
        });

        await waitFor(() => expect(result.current.sentenceIndex).toBe(0));
        await waitFor(() => expect(audioInstances[0]?.src).toBe("blob:test-1"));
        const audio = audioInstances[0];
        expect(result.current.playing).toBe(true);
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(synthesizeMock).toHaveBeenCalledWith("One.");

        // The next sentence is prefetched while the current one plays. Await
        // the synthesis promises themselves so the cache write has landed
        // before playback advances to that sentence.
        await waitFor(() =>
            expect(synthesizeMock).toHaveBeenCalledWith("Two."),
        );
        await act(async () => {
            await Promise.all(
                synthesizeMock.mock.results.map((result) => result.value),
            );
        });

        await act(async () => {
            audio.onended?.();
        });

        await waitFor(() => expect(result.current.sentenceIndex).toBe(1));
        expect(audio.src).toBe("blob:test-2");
        expect(audio.play).toHaveBeenCalledTimes(2);
        // Sentence two came from the cache: no second synthesis call.
        expect(synthesizeMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            audio.onended?.();
        });

        await waitFor(() => expect(result.current.playing).toBe(false));
        expect(result.current.paused).toBe(false);
        expect(result.current.sentenceIndex).toBe(0);
    });

    it("pauses and resumes the current sentence in place", async () => {
        const { result } = renderHook(() =>
            useReadAloud("Only one sentence."),
        );

        await act(async () => {
            result.current.play();
        });
        await waitFor(() => expect(audioInstances[0]?.src).toBe("blob:test-1"));
        const audio = audioInstances[0];

        await act(async () => {
            result.current.pause();
        });

        expect(result.current.paused).toBe(true);
        expect(result.current.playing).toBe(true);
        expect(audio.pause).toHaveBeenCalledTimes(1);

        await act(async () => {
            result.current.resume();
        });

        expect(result.current.paused).toBe(false);
        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(audio.src).toBe("blob:test-1");
    });

    it("applies the chosen speed to live and future audio", async () => {
        const { result } = renderHook(() => useReadAloud("One. Two."));

        act(() => result.current.setSpeed(1.5));
        expect(result.current.speed).toBe(1.5);

        await act(async () => {
            result.current.play();
        });
        await waitFor(() => expect(audioInstances[0]?.src).toBe("blob:test-1"));
        expect(audioInstances[0].playbackRate).toBe(1.5);

        act(() => result.current.setSpeed(0.75));
        expect(result.current.speed).toBe(0.75);
        expect(audioInstances[0].playbackRate).toBe(0.75);
    });

    it("stop revokes every object URL and resets progress", async () => {
        const { result } = renderHook(() => useReadAloud("One. Two."));

        await act(async () => {
            result.current.play();
        });
        await waitFor(() => expect(audioInstances[0]?.src).toBe("blob:test-1"));

        await act(async () => {
            audioInstances[0].onended?.();
        });
        await waitFor(() => expect(audioInstances[0].src).toBe("blob:test-2"));

        act(() => result.current.stop());

        expect(result.current.playing).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(result.current.sentenceIndex).toBe(0);
        expect(result.current.error).toBeNull();
        // The first URL was revoked when playback advanced, the second on stop.
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-1");
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-2");
        expect(audioInstances[0].src).toBe("");
    });

    it("surfaces a synthesis failure and stops playback", async () => {
        synthesizeMock.mockImplementationOnce(() =>
            Promise.reject(new Error("engine exploded")),
        );

        const { result } = renderHook(() =>
            useReadAloud("Only one sentence."),
        );

        await act(async () => {
            result.current.play();
        });

        await waitFor(() =>
            expect(result.current.error).toBe("engine exploded"),
        );
        expect(result.current.playing).toBe(false);
        expect(result.current.sentenceIndex).toBe(0);
    });

    it("does nothing when there is no prose to read", () => {
        const { result } = renderHook(() => useReadAloud("   \n "));

        expect(result.current.sentenceCount).toBe(0);
        act(() => result.current.play());

        expect(result.current.playing).toBe(false);
        expect(synthesizeMock).not.toHaveBeenCalled();
    });

    it("stops playback and drops cached audio when the prose changes", async () => {
        const { result, rerender } = renderHook(
            ({ text }: { text: string }) => useReadAloud(text),
            { initialProps: { text: "One. Two." } },
        );

        await act(async () => {
            result.current.play();
        });
        await waitFor(() =>
            expect(audioInstances[0]?.src).toBe("blob:test-1"),
        );

        rerender({ text: "Three. Four." });

        await waitFor(() => expect(result.current.playing).toBe(false));
        expect(result.current.sentenceCount).toBe(2);
        expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:test-1");
    });

    it("clears a playback error when the prose changes", async () => {
        synthesizeMock.mockImplementationOnce(() =>
            Promise.reject(new Error("engine exploded")),
        );
        const { result, rerender } = renderHook(
            ({ text }: { text: string }) => useReadAloud(text),
            { initialProps: { text: "One." } },
        );

        await act(async () => {
            result.current.play();
        });
        await waitFor(() =>
            expect(result.current.error).toBe("engine exploded"),
        );

        rerender({ text: "One. Two." });

        await waitFor(() => expect(result.current.error).toBeNull());
        expect(result.current.sentenceCount).toBe(2);
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

        for (const text of ["One. Two", "One. Two.", "One. Two. Three."]) {
            rerender({ text });
        }

        // One render per new prop, none from the reset effect.
        expect(renders - before).toBe(3);
        expect(result.current.playing).toBe(false);
        expect(result.current.error).toBeNull();
        expect(revokeObjectURLMock).not.toHaveBeenCalled();
    });
});
