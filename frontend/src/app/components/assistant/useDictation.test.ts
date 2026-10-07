import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeAudio } = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));

import type * as MikeApiModule from "@/app/lib/mikeApi";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    transcribeAudio,
}));

import { MikeApiError } from "@/app/lib/mikeApi";
import {
    DICTATION_UNSUPPORTED_MESSAGE,
    MICROPHONE_ACCESS_DENIED_MESSAGE,
    useDictation,
} from "./useDictation";

/** MediaRecorder double: captures option state and mirrors the browser's
 * dataavailable-then-stop event order on stop(). */
class MockMediaRecorder {
    static instances: MockMediaRecorder[] = [];
    static suppressDataAvailable = false;
    static failStart = false;
    static isTypeSupported = vi.fn(
        (type: string) => type === "audio/webm;codecs=opus",
    );

    state: "inactive" | "recording" = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType ?? "";
        MockMediaRecorder.instances.push(this);
    }

    start() {
        if (MockMediaRecorder.failStart) {
            throw new Error("cannot start recorder");
        }
        this.state = "recording";
    }

    stop() {
        this.state = "inactive";
        if (!MockMediaRecorder.suppressDataAvailable) {
            this.ondataavailable?.({
                data: new Blob(["clip"], {
                    type: this.mimeType || "audio/webm",
                }),
            });
        }
        this.onstop?.();
    }
}

const stopTrack = vi.fn();
const getUserMedia = vi.fn<() => Promise<MediaStream>>();

const fakeStream = () =>
    ({
        getTracks: () => [{ stop: stopTrack }],
    }) as unknown as MediaStream;

beforeEach(() => {
    vi.clearAllMocks();
    MockMediaRecorder.instances = [];
    MockMediaRecorder.suppressDataAvailable = false;
    MockMediaRecorder.failStart = false;
    getUserMedia.mockResolvedValue(fakeStream());
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("useDictation", () => {
    it("starts a recording with the first supported container", async () => {
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
        const recorder = MockMediaRecorder.instances.at(-1);
        expect(recorder?.mimeType).toBe("audio/webm;codecs=opus");
        expect(recorder?.state).toBe("recording");
        expect(result.current.recording).toBe(true);

        // A second start while recording must not open another capture.
        await act(async () => {
            await result.current.start();
        });
        expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it("does not start while disabled", async () => {
        const { result } = renderHook(() =>
            useDictation({ disabled: true }),
        );

        await act(async () => {
            await result.current.start();
        });

        expect(getUserMedia).not.toHaveBeenCalled();
        expect(result.current.recording).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it("transcribes a stopped recording and exposes the transcript once", async () => {
        transcribeAudio.mockResolvedValue({ text: "  Hello there  " });
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            result.current.toggle();
        });

        await waitFor(() =>
            expect(result.current.transcript).toBe("Hello there"),
        );
        expect(result.current.transcriptVersion).toBe(1);
        expect(result.current.recording).toBe(false);
        expect(result.current.busy).toBe(false);
        expect(stopTrack).toHaveBeenCalled();

        const recorded = transcribeAudio.mock.calls[0][0];
        expect(recorded).toBeInstanceOf(Blob);
        expect(recorded.type).toBe("audio/webm;codecs=opus");
    });

    it("reports busy while a stop is being transcribed and blocks a new start", async () => {
        let resolveTranscription:
            | ((value: { text: string }) => void)
            | undefined;
        transcribeAudio.mockImplementation(
            () =>
                new Promise<{ text: string }>((resolve) => {
                    resolveTranscription = resolve;
                }),
        );
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            result.current.toggle();
        });
        await waitFor(() => expect(result.current.busy).toBe(true));

        // A second toggle while transcribing must not open the microphone.
        act(() => {
            result.current.toggle();
        });
        expect(getUserMedia).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveTranscription?.({ text: "ok" });
            await Promise.resolve();
        });
        await waitFor(() => expect(result.current.busy).toBe(false));
        expect(result.current.transcript).toBe("ok");
    });

    it("covers the recording time every second", async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        expect(result.current.elapsedMs).toBe(0);

        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(result.current.elapsedMs).toBe(3000);
    });

    it("surfaces a denied microphone and clears the error on demand", async () => {
        getUserMedia.mockRejectedValue(
            new DOMException("Permission denied", "NotAllowedError"),
        );
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.error).toBe(MICROPHONE_ACCESS_DENIED_MESSAGE);
        expect(result.current.recording).toBe(false);

        act(() => {
            result.current.clearError();
        });
        expect(result.current.error).toBeNull();
    });

    it("surfaces other capture failures without blaming permissions", async () => {
        getUserMedia.mockRejectedValue(
            new DOMException("No device", "NotFoundError"),
        );
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.error).toBe(
            "Could not start recording. Please try again.",
        );
    });

    it("releases the stream when the recorder refuses to start", async () => {
        MockMediaRecorder.failStart = true;
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.error).toBe(
            "Could not start recording. Please try again.",
        );
        expect(result.current.recording).toBe(false);
        expect(stopTrack).toHaveBeenCalled();
    });

    it("reports a browser without recording support", async () => {
        vi.stubGlobal("MediaRecorder", undefined);
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.error).toBe(DICTATION_UNSUPPORTED_MESSAGE);
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("reports a browser without microphone access", async () => {
        Reflect.deleteProperty(navigator, "mediaDevices");
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.error).toBe(DICTATION_UNSUPPORTED_MESSAGE);
    });

    it("surfaces a failed transcription through the shared error mapping", async () => {
        transcribeAudio.mockRejectedValue(
            new MikeApiError({ message: "Audio is too long", status: 413 }),
        );
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            result.current.stop();
        });

        await waitFor(() =>
            expect(result.current.error).toBe("Audio is too long"),
        );
        expect(result.current.transcript).toBeNull();
        expect(result.current.busy).toBe(false);
    });

    it("treats an empty recording as nothing to transcribe", async () => {
        MockMediaRecorder.suppressDataAvailable = true;
        const { result } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            result.current.stop();
        });

        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(result.current.error).toBeNull();
        expect(result.current.busy).toBe(false);
    });

    it("stops and releases an active recording on unmount", async () => {
        const { result, unmount } = renderHook(() => useDictation());

        await act(async () => {
            await result.current.start();
        });
        const recorder = MockMediaRecorder.instances.at(-1);
        const stopRecorder = vi.spyOn(recorder!, "stop");

        unmount();

        expect(stopRecorder).toHaveBeenCalled();
        expect(stopTrack).toHaveBeenCalled();
        expect(transcribeAudio).not.toHaveBeenCalled();
    });

    it("releases a microphone granted after unmount", async () => {
        let resolveStream: ((stream: MediaStream) => void) | undefined;
        getUserMedia.mockImplementation(
            () =>
                new Promise<MediaStream>((resolve) => {
                    resolveStream = resolve;
                }),
        );
        const { result, unmount } = renderHook(() => useDictation());

        let startPromise: Promise<void> | undefined;
        act(() => {
            startPromise = result.current.start();
        });
        unmount();
        await act(async () => {
            resolveStream?.(fakeStream());
            await startPromise;
        });

        expect(stopTrack).toHaveBeenCalled();
        expect(MockMediaRecorder.instances).toHaveLength(0);
    });
});
