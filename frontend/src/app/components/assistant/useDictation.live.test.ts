import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phone = vi.hoisted(() => ({
    liveDictationAvailable: vi.fn(async () => true),
    startLiveDictation: vi.fn(async (..._args: unknown[]) => undefined),
    stopLiveDictation: vi.fn(async () => "final words"),
    cancelLiveDictation: vi.fn(),
    fluidSpeechMiniAvailable: vi.fn(async () => true),
    prepareFluidSpeechMini: vi.fn(),
}));

import type * as DeviceSpeechModule from "@/app/lib/voice/deviceSpeech";

vi.mock("@/app/lib/voice/deviceSpeech", async (importOriginal) => ({
    ...(await importOriginal<typeof DeviceSpeechModule>()),
    ...phone,
}));

const api = vi.hoisted(() => ({
    transcribeAudio: vi.fn(),
    getDictationVocabulary: vi.fn(async () => ({ terms: ["Okonkwo-Lindqvist"] })),
}));
import type * as MikeApiModule from "@/app/lib/mikeApi";
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    ...api,
}));

import { LiveDictationError, type LiveDictationEvent } from "@/app/lib/voice/deviceSpeech";
import { resetDictationVocabulary } from "@/app/lib/voice/dictationVocabulary";
import { VOICE_PREFERENCES_KEY } from "@/app/lib/voice/preferences";
import { MICROPHONE_ACCESS_DENIED_MESSAGE, useDictation } from "./useDictation";

let send: (event: LiveDictationEvent) => void;

function prefer(transcription: Record<string, unknown>) {
    window.localStorage.setItem(
        VOICE_PREFERENCES_KEY,
        JSON.stringify({ transcription, speech: { engine: "operator" } }),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    resetDictationVocabulary();
    phone.liveDictationAvailable.mockResolvedValue(true);
    phone.stopLiveDictation.mockResolvedValue("final words");
    phone.startLiveDictation.mockImplementation(async (...args: unknown[]) => {
        send = args[0] as typeof send;
    });
    prefer({ engine: "device", language: "en-US" });
});

afterEach(() => {
    window.localStorage.removeItem(VOICE_PREFERENCES_KEY);
    vi.useRealTimers();
});

async function startLive() {
    const hook = renderHook(() => useDictation());
    await act(async () => {
        await hook.result.current.start();
    });
    return hook;
}

describe("useDictation with live dictation", () => {
    it("records on the phone and shows the text as it arrives, the vocabulary applied to the confirmed part", async () => {
        const { result } = await startLive();
        expect(phone.startLiveDictation).toHaveBeenCalledTimes(1);
        expect(result.current.recording).toBe(true);
        expect(result.current.liveText).toEqual({ confirmed: "", volatile: "" });

        act(() => send({ kind: "text", confirmed: "ask Conquo Lindqvist", volatile: "and", ended: false }));
        expect(result.current.liveText).toEqual({ confirmed: "ask Okonkwo-Lindqvist", volatile: "and" });
        act(() => send({ kind: "level", level: 0.4 }));
    });

    it("ticks the elapsed time", async () => {
        vi.useFakeTimers();
        const { result } = await startLive();
        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(result.current.elapsedMs).toBeGreaterThanOrEqual(3000);
    });

    it("stop inserts the final corrected text once and clears the live text", async () => {
        phone.stopLiveDictation.mockResolvedValueOnce("  ask Conquo Lindqvist ");
        const { result } = await startLive();
        await act(async () => {
            result.current.stop();
        });
        await waitFor(() => expect(result.current.transcript).toBe("ask Okonkwo-Lindqvist"));
        expect(result.current.transcriptVersion).toBe(1);
        expect(result.current.recording).toBe(false);
        expect(result.current.busy).toBe(false);
        expect(result.current.liveText).toBeNull();
        expect(phone.stopLiveDictation).toHaveBeenCalledTimes(1);
        // The recorder of the web view is never opened.
        expect(phone.cancelLiveDictation).not.toHaveBeenCalled();
    });

    it("toggle starts and stops", async () => {
        const { result } = await startLive();
        await act(async () => {
            result.current.toggle();
        });
        await waitFor(() => expect(result.current.transcriptVersion).toBe(1));
        await act(async () => {
            result.current.toggle();
        });
        await waitFor(() => expect(phone.startLiveDictation).toHaveBeenCalledTimes(2));
        act(() => result.current.cancel());
    });

    it("an empty final text inserts nothing", async () => {
        phone.stopLiveDictation.mockResolvedValueOnce("   ");
        const { result } = await startLive();
        await act(async () => {
            result.current.stop();
        });
        await waitFor(() => expect(result.current.busy).toBe(false));
        expect(result.current.transcript).toBeNull();
    });

    it("cancel discards: nothing is inserted and the phone is told to release the microphone", async () => {
        const { result } = await startLive();
        act(() => result.current.cancel());
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(1);
        expect(phone.stopLiveDictation).not.toHaveBeenCalled();
        expect(result.current.recording).toBe(false);
        expect(result.current.liveText).toBeNull();
        expect(result.current.transcript).toBeNull();
        // A stop afterwards does nothing.
        act(() => result.current.stop());
        expect(phone.stopLiveDictation).not.toHaveBeenCalled();
    });

    it("an interruption reported by the phone ends the dictation and keeps the text so far", async () => {
        phone.stopLiveDictation.mockResolvedValueOnce("kept text");
        const { result } = await startLive();
        act(() => send({ kind: "text", confirmed: "kept text", volatile: "", ended: true }));
        await waitFor(() => expect(result.current.transcript).toBe("kept text"));
        expect(result.current.recording).toBe(false);
        expect(result.current.liveText).toBeNull();
        // Late events are ignored.
        act(() => send({ kind: "text", confirmed: "late", volatile: "", ended: false }));
        expect(result.current.liveText).toBeNull();
    });

    it("removes the listener (cancels) when the page unmounts while recording", async () => {
        const { unmount } = await startLive();
        unmount();
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(1);
    });

    it("does not cancel again on unmount after a stop", async () => {
        const { result, unmount } = await startLive();
        await act(async () => {
            result.current.stop();
        });
        await waitFor(() => expect(result.current.busy).toBe(false));
        unmount();
        expect(phone.cancelLiveDictation).not.toHaveBeenCalled();
    });

    it("releases the microphone when the page unmounts while it is still opening", async () => {
        let finish: () => void = () => undefined;
        phone.startLiveDictation.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
        );
        const hook = renderHook(() => useDictation());
        let starting: Promise<void> = Promise.resolve();
        act(() => {
            starting = hook.result.current.start();
        });
        await waitFor(() => expect(phone.startLiveDictation).toHaveBeenCalled());
        hook.unmount();
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(1);
        finish();
        await starting;
        // Cancelled again once the start resolved, in case the phone began after the first cancel.
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(2);
    });

    it("maps a refused microphone to the usual message", async () => {
        phone.startLiveDictation.mockRejectedValueOnce(new LiveDictationError("raw", "permission-denied"));
        const { result } = await startLive();
        expect(result.current.error).toBe(MICROPHONE_ACCESS_DENIED_MESSAGE);
        expect(result.current.recording).toBe(false);
        expect(result.current.liveText).toBeNull();
    });

    it("shows the message of other start failures, and a generic one for unknown errors", async () => {
        phone.startLiveDictation.mockRejectedValueOnce(new LiveDictationError("Could not start recording. Please try again.", "failed"));
        const first = await startLive();
        expect(first.result.current.error).toBe("Could not start recording. Please try again.");
        phone.startLiveDictation.mockRejectedValueOnce(new Error("bridge"));
        const second = await startLive();
        expect(second.result.current.error).toBe("Could not start recording. Please try again.");
    });

    it("shows a stop failure and leaves the composer unchanged", async () => {
        phone.stopLiveDictation.mockRejectedValueOnce(new LiveDictationError("Could not transcribe the recording on this iPhone. Please try again."));
        const { result } = await startLive();
        await act(async () => {
            result.current.stop();
        });
        await waitFor(() => expect(result.current.error).toContain("Could not transcribe"));
        expect(result.current.transcript).toBeNull();
        expect(result.current.busy).toBe(false);
        expect(result.current.liveText).toBeNull();
    });

    it("does not insert text after the page has gone", async () => {
        let resolveStop: (text: string) => void = () => undefined;
        phone.stopLiveDictation.mockImplementationOnce(() => new Promise<string>((resolve) => (resolveStop = resolve)));
        const { result, unmount } = await startLive();
        act(() => result.current.stop());
        unmount();
        await act(async () => resolveStop("late text"));
    });

    it("cancel while the microphone is opening discards the start", async () => {
        let finish: () => void = () => undefined;
        phone.startLiveDictation.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
        );
        const hook = renderHook(() => useDictation());
        let starting: Promise<void> = Promise.resolve();
        act(() => {
            starting = hook.result.current.start();
        });
        await waitFor(() => expect(phone.startLiveDictation).toHaveBeenCalled());
        act(() => hook.result.current.cancel());
        finish();
        await act(async () => starting);
        expect(hook.result.current.recording).toBe(false);
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(2);
    });
});

describe("useDictation falls back to recording a clip", () => {
    const getUserMedia = vi.fn<() => Promise<MediaStream>>();
    beforeEach(() => {
        getUserMedia.mockReset();
        getUserMedia.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
        vi.stubGlobal("MediaRecorder", class {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(navigator, "mediaDevices");
    });

    it("when the app build has no live dictation", async () => {
        phone.liveDictationAvailable.mockResolvedValue(false);
        const { result } = await startLive();
        expect(phone.startLiveDictation).not.toHaveBeenCalled();
        expect(getUserMedia).toHaveBeenCalled();
        expect(result.current.error).toBe(MICROPHONE_ACCESS_DENIED_MESSAGE);
        expect(result.current.liveText).toBeNull();
    });

    it("for Apple's recognizer, another language and other engines", async () => {
        for (const transcription of [
            { engine: "device", model: "apple" },
            { engine: "device", language: "fr-FR" },
            { engine: "operator" },
        ]) {
            prefer(transcription);
            await startLive();
        }
        expect(phone.startLiveDictation).not.toHaveBeenCalled();
        expect(getUserMedia).toHaveBeenCalledTimes(3);
    });
});
