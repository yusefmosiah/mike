import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";
import { recordSpokenAnswer } from "@/app/lib/mikeApi";
import { VOICE_PREFERENCES_KEY } from "@/app/lib/voice/preferences";
import { endedMessage, VOICE_MICROPHONE_MESSAGE, VOICE_UNAVAILABLE_MESSAGE } from "@/app/lib/voice/voiceEngine";
import { voiceModeActive } from "@/app/lib/voice/voiceMode";
import {
    activityOf,
    INTERRUPT_WAIT_MS,
    RECORD_WAIT_MS,
    SEND_TIMEOUT_MS,
    useVoiceChat,
    VOICE_SEND_FAILURE_MESSAGE,
} from "./useVoiceChat";

vi.mock("@/app/lib/mikeApi", () => ({ recordSpokenAnswer: vi.fn(async () => undefined) }));
vi.mock("@/app/lib/voice/dictationVocabulary", () => ({
    loadUserVocabulary: vi.fn(async () => []),
    currentDictationVocabulary: () => ({ terms: ["Ximena Achterberg"], automatic: [] }),
}));
vi.mock("@/app/lib/voice/vocabulary", () => ({
    correctWithVocabulary: (text: string) => text.replace("ximena acterberg", "Ximena Achterberg"),
}));

const recordMock = vi.mocked(recordSpokenAnswer);

/** The native engine: answers to each method, and the events it sends. */
const nativePromise = vi.fn();
const remove = vi.fn();
let emitNative: ((data: unknown) => void) | null = null;
const addListener = vi.fn((_plugin: string, _event: string, callback: (data: unknown) => void) => {
    emitNative = callback;
    return { remove };
});
let status: unknown = { available: true, missing: [], downloadBytes: 0 };

function calls(method: string) {
    return nativePromise.mock.calls.filter(([, name]) => name === method).map(([, , options]) => options);
}

function emit(event: Record<string, unknown>) {
    act(() => emitNative?.(event));
}

beforeEach(() => {
    status = { available: true, missing: [], downloadBytes: 0 };
    nativePromise.mockImplementation(async (_plugin: string, method: string) => {
        if (method === "voiceStatus") return status;
        if (method === "voiceInstall") return { available: true };
        return undefined;
    });
    vi.stubGlobal("Capacitor", {
        PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "voiceStatus" }] }],
        nativePromise,
        addListener,
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    nativePromise.mockReset();
    remove.mockReset();
    addListener.mockClear();
    recordMock.mockClear();
    emitNative = null;
    window.localStorage.clear();
});

/**
 * The hook in a thread that behaves like useAssistantChat: sending adds the
 * prompt and an empty answer and starts loading; `stream` grows the answer;
 * `finish` ends loading.
 */
function renderVoiceChat(
    options: { sendOk?: boolean; silent?: boolean; chatId?: string | null; replace?: boolean | "reject" } = {},
) {
    const sent: string[] = [];
    const replaced: [string, string][] = [];
    const cancelResponse = vi.fn();
    const hook = renderHook(
        ({ chatId }: { chatId: string | null }) => {
            const [messages, setMessages] = useState<Message[]>([
                { id: "u0", role: "user", content: "Earlier" },
                { id: "a0", role: "assistant", content: "An earlier answer." },
            ]);
            const [loading, setLoading] = useState(false);
            const voice = useVoiceChat({
                chatId,
                messages,
                isResponseLoading: loading,
                send: (text) => {
                    if (options.sendOk === false) return false;
                    sent.push(text);
                    // A send the chat ignored (another turn holds the thread).
                    if (options.silent) return true;
                    setMessages((prev) => [
                        ...prev,
                        { role: "user", content: text, voice: true },
                        { role: "assistant", content: "", events: [] },
                    ]);
                    setLoading(true);
                    return true;
                },
                // As the branch actions do: the new version takes the old
                // prompt's place, the rest of that branch goes, and it is answered.
                replacePrompt: options.replace
                    ? async (messageId, text) => {
                          if (options.replace === "reject") throw new Error("busy");
                          replaced.push([messageId, text]);
                          setMessages((prev) => [
                              ...prev.slice(0, prev.findIndex((message) => message.id === messageId)),
                              { id: "u-new", role: "user", content: text, voice: true },
                              { role: "assistant", content: "", events: [] },
                          ]);
                          setLoading(true);
                      }
                    : undefined,
                cancelResponse: () => {
                    cancelResponse();
                    setLoading(false);
                },
                config: { pauseMs: 300 },
            });
            return { voice, setMessages, setLoading };
        },
        { initialProps: { chatId: options.chatId === undefined ? "chat-1" : options.chatId } },
    );
    const updateAnswer = (update: (answer: Message) => Message) =>
        act(() =>
            hook.result.current.setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = update(next[next.length - 1]);
                return next;
            }),
        );
    return {
        ...hook,
        sent,
        replaced,
        cancelResponse,
        // As the chat stream's first frame does: the sent prompt gets its stored id.
        namePrompt: (id: string) =>
            act(() =>
                hook.result.current.setMessages((prev) => {
                    const next = [...prev];
                    const at = next.findLastIndex((message) => message.role === "user");
                    next[at] = { ...next[at], id };
                    return next;
                }),
            ),
        // As the chat stream does: the piece being written is marked streaming.
        stream: (text: string, id = "a1") =>
            updateAnswer((answer) => ({ ...answer, id, events: [{ type: "content", text, isStreaming: true }] })),
        // Text, then a tool call that is running, then (optionally) the text after it.
        streamAroundTool: (before: string, after?: string, id = "a1") =>
            updateAnswer((answer) => ({
                ...answer,
                id,
                events: [
                    { type: "content", text: before },
                    { type: "tool_call_start" as const, name: "read_document", isStreaming: true },
                    ...(after === undefined ? [] : [{ type: "content" as const, text: after, isStreaming: true }]),
                ],
            })),
        fail: () => updateAnswer((answer) => ({ ...answer, error: "Sorry, something went wrong." })),
        finish: () => act(() => hook.result.current.setLoading(false)),
    };
}

async function started(options?: Parameters<typeof renderVoiceChat>[0]) {
    const view = renderVoiceChat(options);
    await act(() => view.result.current.voice.start());
    expect(view.result.current.voice.phase).toBe("on");
    return view;
}

const ANSWER =
    "Under the lease, the tenant must give **ninety days'** written notice [1]. " +
    "The landlord may then inspect the premises, and any damage is the tenant's to repair.";

describe("useVoiceChat", () => {
    it("is supported only where the app has the voice engine", () => {
        expect(renderVoiceChat().result.current.voice.supported).toBe(true);
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech" }], nativePromise });
        expect(renderVoiceChat().result.current.voice.supported).toBe(false);
    });

    it("starts the engine with the config and the chosen Phonon voice, and only once", async () => {
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ speech: { engine: "device", voice: "Harper" } }));
        const { result } = renderVoiceChat();
        expect(result.current.voice.phase).toBe("off");
        await act(async () => {
            await Promise.all([result.current.voice.start(), result.current.voice.start()]);
        });
        expect(result.current.voice.phase).toBe("on");
        expect(result.current.voice.activity).toBe("listening");
        expect(calls("voiceStart")).toEqual([{ config: { pauseMs: 300 }, voice: "Harper" }]);
        expect(addListener).toHaveBeenCalledWith("MikeSpeech", "voiceEvent", expect.any(Function));
    });

    it("passes the chosen speaker model to the engine", async () => {
        window.localStorage.setItem("mike.voice.speakerModel.v1", "campplus");
        await started();
        expect(calls("voiceStart")).toEqual([{ config: { speakerModel: "campplus", pauseMs: 300 } }]);
        window.localStorage.removeItem("mike.voice.speakerModel.v1");
    });

    it("leaves out a voice that is not Phonon's", async () => {
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ speech: { engine: "device", voice: "com.apple.Samantha" } }));
        await started();
        expect(calls("voiceStart")).toEqual([{ config: { pauseMs: 300 } }]);
    });

    it("clears the live words of a turn in another voice and says so until the person speaks", async () => {
        const view = await started();
        emit({ type: "partial", text: "and now the weather" });
        emit({ type: "ignored", reason: "other-voice" });
        expect(view.result.current.voice.partial).toBe("");
        expect(view.result.current.voice.ignoredOtherVoice).toBe(true);
        expect(view.sent).toEqual([]);
        emit({ type: "partial", text: "" });
        expect(view.result.current.voice.ignoredOtherVoice).toBe(true);
        emit({ type: "partial", text: "what does" });
        expect(view.result.current.voice.ignoredOtherVoice).toBe(false);
    });

    it("sends a turn as a chat message, speaks the answer clause by clause as it streams, and ends it", async () => {
        const view = await started();
        emit({ type: "state", state: "user-speaking" });
        emit({ type: "partial", text: "what does the lease" });
        expect(view.result.current.voice.partial).toBe("what does the lease");
        expect(view.result.current.voice.activity).toBe("listening");
        emit({ type: "turn", turnId: "t1", text: " what notice does ximena acterberg owe ", audioMs: 2100 });
        expect(view.sent).toEqual(["what notice does Ximena Achterberg owe"]);
        expect(view.result.current.voice.partial).toBe("");
        emit({ type: "state", state: "thinking" });
        expect(view.result.current.voice.activity).toBe("thinking");

        view.stream(ANSWER.slice(0, 75));
        expect(calls("voiceSpeak")).toEqual([{ turnId: "t1", clauseId: 0, text: "Under the lease, the tenant must give," }]);
        view.stream(ANSWER);
        expect(calls("voiceSpeak").map((call) => (call as { text: string }).text)).toEqual([
            "Under the lease, the tenant must give,",
            "ninety days' written notice.",
            "The landlord may then inspect the premises,",
        ]);
        view.finish();
        expect(calls("voiceSpeak").at(-1)).toEqual({
            turnId: "t1",
            clauseId: 3,
            text: "and any damage is the tenant's to repair.",
            final: true,
        });
        expect(calls("voiceEndAnswer")).toEqual([{ turnId: "t1" }]);
        emit({ type: "state", state: "speaking" });
        expect(view.result.current.voice.activity).toBe("speaking");
        emit({ type: "answerFinished", turnId: "t1" });
        emit({ type: "metrics", turnId: "t1", stages: { commitToFirstAudio: 700 } });
        // Later renders send nothing more.
        view.stream(`${ANSWER} More.`);
        expect(calls("voiceSpeak")).toHaveLength(4);
        expect(recordMock).not.toHaveBeenCalled();
        expect(view.cancelResponse).not.toHaveBeenCalled();
    });

    it("speaks what the answer says before a tool call at once, then carries on after it", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream("Let me check the lease.");
        expect(calls("voiceSpeak")).toEqual([]);
        view.streamAroundTool("Let me check the lease.");
        expect(calls("voiceSpeak")).toEqual([{ turnId: "t1", clauseId: 0, text: "Let me check the lease." }]);
        expect(calls("voiceEndAnswer")).toEqual([]);
        view.streamAroundTool("Let me check the lease.", "Clause 12 needs ninety days' written notice.");
        view.finish();
        expect(calls("voiceSpeak").map((call) => (call as { text: string }).text)).toEqual([
            "Let me check the lease.",
            "Clause 12 needs ninety days' written notice.",
        ]);
        expect(calls("voiceEndAnswer")).toEqual([{ turnId: "t1" }]);
    });

    it("on a barge-in mid-answer stops the chat turn and records what was heard", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clauseStarted", turnId: "t1", clauseId: 0 });
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "clauseStarted", turnId: "t1", clauseId: 1 });
        emit({ type: "bargeIn", turnId: "t1" });
        expect(view.cancelResponse).toHaveBeenCalledTimes(1);
        // The clause playing reports where it stopped.
        expect(recordMock).not.toHaveBeenCalled();
        emit({ type: "interrupted", turnId: "t1", clauseId: 1, fraction: 0.7 });
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "Under the lease, the tenant must give **ninety days'** written");
        // Nothing more is spoken for the turn, and it is recorded once.
        view.stream(ANSWER);
        emit({ type: "interrupted", turnId: "t1", clauseId: 1, fraction: 0.9 });
        expect(calls("voiceSpeak")).toHaveLength(2);
        expect(recordMock).toHaveBeenCalledTimes(1);
        expect(view.cancelResponse).toHaveBeenCalledTimes(1);
    });

    it("records the clauses heard when a barge-in comes between clauses", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "bargeIn", turnId: "t1" });
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "Under the lease, the tenant must give");
    });

    it("on a barge-in while thinking cancels the turn and records that nothing was heard, once the answer has an id", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        emit({ type: "bargeIn", turnId: "t1" });
        expect(view.cancelResponse).toHaveBeenCalledTimes(1);
        expect(recordMock).not.toHaveBeenCalled();
        view.stream("", "a7");
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a7", "");
        // Events for another turn, or none, change nothing.
        emit({ type: "bargeIn", turnId: "other" });
        emit({ type: "interrupted", turnId: "other", clauseId: 0, fraction: 1 });
        emit({ type: "clauseStarted", turnId: "other", clauseId: 0 });
        expect(recordMock).toHaveBeenCalledTimes(1);
    });

    it("sends the next turn once a cut-off answer has stopped", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
        view.stream(ANSWER.slice(0, 50));
        // The person goes on without a barge-in event.
        emit({ type: "turn", turnId: "t2", text: "second question", audioMs: 900 });
        expect(view.cancelResponse).toHaveBeenCalledTimes(1);
        expect(calls("voiceCancelAnswer")).toEqual([{ turnId: "t1" }]);
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "");
        await waitFor(() => expect(view.sent).toEqual(["first question", "second question"]));
    });

    it("drops a turn spoken over before it was sent", async () => {
        const view = await started();
        act(() => view.result.current.setLoading(true));
        emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
        emit({ type: "bargeIn", turnId: "t1" });
        view.finish();
        expect(view.sent).toEqual([]);
        expect(view.cancelResponse).not.toHaveBeenCalled();
        expect(recordMock).not.toHaveBeenCalled();
    });

    it("cancels an empty turn", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "   ", audioMs: 300 });
        expect(view.sent).toEqual([]);
        expect(calls("voiceCancelAnswer")).toEqual([{ turnId: "t1" }]);
    });

    it("cancels the engine's answer when the chat turn fails", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream("The notice period is ninety days");
        view.fail();
        expect(calls("voiceCancelAnswer")).toEqual([{ turnId: "t1" }]);
        view.finish();
        expect(calls("voiceEndAnswer")).toEqual([]);
    });

    it("ends voice mode when a turn cannot be sent", async () => {
        const view = await started({ sendOk: false });
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        await waitFor(() => expect(view.result.current.voice.phase).toBe("off"));
        expect(view.result.current.voice.error).toBe(VOICE_SEND_FAILURE_MESSAGE);
        expect(calls("voiceCancelAnswer")).toEqual([{ turnId: "t1" }]);
        expect(calls("voiceStop")).toHaveLength(1);
        act(() => view.result.current.voice.clearError());
        expect(view.result.current.voice.error).toBeNull();
    });

    it("ends voice mode when a sent turn never starts an answer", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const view = renderVoiceChat({ silent: true });
        await act(() => view.result.current.voice.start());
        // Sending appears to work, but nothing arrives.
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        expect(view.sent).toEqual(["what notice"]);
        act(() => {
            vi.advanceTimersByTime(SEND_TIMEOUT_MS);
        });
        await act(async () => undefined);
        expect(view.result.current.voice.error).toBe(VOICE_SEND_FAILURE_MESSAGE);
    });

    it("keeps voice mode when the answer arrived before the check", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        act(() => {
            vi.advanceTimersByTime(SEND_TIMEOUT_MS);
        });
        expect(view.result.current.voice.phase).toBe("on");
        // A timer from a turn already replaced does nothing either.
        view.finish();
        emit({ type: "turn", turnId: "t2", text: "next", audioMs: 900 });
        emit({ type: "turn", turnId: "t3", text: "and next", audioMs: 900 });
        act(() => {
            vi.advanceTimersByTime(SEND_TIMEOUT_MS);
        });
        expect(view.result.current.voice.phase).toBe("on");
    });

    it("ends when the engine ends, saying why", async () => {
        const view = await started();
        emit({ type: "ended", reason: "interruption" });
        expect(view.result.current.voice.phase).toBe("off");
        expect(view.result.current.voice.error).toBe(endedMessage("interruption"));
        const other = await started();
        emit({ type: "ended", reason: "stopped" });
        expect(other.result.current.voice.phase).toBe("off");
        expect(other.result.current.voice.error).toBeNull();
    });

    it("says why the engine could not start", async () => {
        nativePromise.mockImplementation(async (_plugin: string, method: string) => {
            if (method === "voiceStatus") return status;
            throw { code: "permission-denied" };
        });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        expect(view.result.current.voice.phase).toBe("off");
        expect(view.result.current.voice.error).toBe(VOICE_MICROPHONE_MESSAGE);
        expect(remove).toHaveBeenCalled();
    });

    it("ends quietly when the engine was stopped before it started (cancelled)", async () => {
        nativePromise.mockImplementation(async (_plugin: string, method: string) => {
            if (method === "voiceStatus") return status;
            throw { code: "cancelled" };
        });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        expect(view.result.current.voice.phase).toBe("off");
        expect(view.result.current.voice.error).toBeNull();
        expect(remove).toHaveBeenCalled();
    });

    it("says when this phone cannot run voice mode", async () => {
        status = { available: false, missing: [], downloadBytes: 0 };
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        expect(view.result.current.voice.phase).toBe("off");
        expect(view.result.current.voice.error).toBe(VOICE_UNAVAILABLE_MESSAGE);
    });

    it("downloads missing models with progress, then starts", async () => {
        status = { available: false, missing: ["eou", "phonon"], downloadBytes: 420e6 };
        let finishInstall: (value: unknown) => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve(status);
            if (method === "voiceInstall") return new Promise((resolve) => (finishInstall = resolve));
            return Promise.resolve(undefined);
        });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        expect(view.result.current.voice.phase).toBe("setup");
        expect(view.result.current.voice.downloadBytes).toBe(420e6);
        let installing: Promise<void> = Promise.resolve();
        act(() => {
            installing = view.result.current.voice.install();
        });
        expect(view.result.current.voice.phase).toBe("installing");
        expect(view.result.current.voice.installProgress).toBe(0);
        emit({ type: "install", fraction: 0.4 });
        emit({ type: "partial", text: "ignored while installing" });
        expect(view.result.current.voice.installProgress).toBe(0.4);
        await act(async () => {
            finishInstall({ available: true });
            await installing;
        });
        expect(view.result.current.voice.phase).toBe("on");
        expect(view.result.current.voice.installProgress).toBeNull();
        // Installing again does nothing outside setup.
        await act(() => view.result.current.voice.install());
        expect(calls("voiceInstall")).toHaveLength(1);
    });

    it("returns to setup with the reason when the download fails", async () => {
        status = { available: false, missing: ["eou"], downloadBytes: 1e6 };
        nativePromise.mockImplementation(async (_plugin: string, method: string) => {
            if (method === "voiceStatus") return status;
            if (method === "voiceInstall") throw new Error("offline");
            return undefined;
        });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        await act(() => view.result.current.voice.install());
        expect(view.result.current.voice.phase).toBe("setup");
        expect(view.result.current.voice.error).toMatch(/download/);
        nativePromise.mockImplementation(async (_plugin: string, method: string) =>
            method === "voiceStatus" ? status : method === "voiceInstall" ? { available: false } : undefined,
        );
        await act(() => view.result.current.voice.install());
        expect(view.result.current.voice.phase).toBe("setup");
    });

    it("ignores a start or a download that finishes after voice mode was ended", async () => {
        let finishStatus: (value: unknown) => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) =>
            method === "voiceStatus" ? new Promise((resolve) => (finishStatus = resolve)) : Promise.resolve(undefined),
        );
        const view = renderVoiceChat();
        let starting: Promise<void> = Promise.resolve();
        act(() => {
            starting = view.result.current.voice.start();
        });
        expect(view.result.current.voice.phase).toBe("checking");
        act(() => view.result.current.voice.stop());
        await act(async () => {
            finishStatus({ available: true });
            await starting;
        });
        expect(view.result.current.voice.phase).toBe("off");
        expect(calls("voiceStart")).toEqual([]);

        // Stopped while the engine starts.
        let finishStart: () => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve({ available: true, missing: [] });
            if (method === "voiceStart") return new Promise<void>((resolve) => (finishStart = resolve));
            return Promise.resolve(undefined);
        });
        act(() => {
            starting = view.result.current.voice.start();
        });
        await waitFor(() => expect(calls("voiceStart")).toHaveLength(1));
        act(() => view.result.current.voice.stop());
        await act(async () => {
            finishStart();
            await starting;
        });
        expect(view.result.current.voice.phase).toBe("off");

        // Stopped while the engine refuses to start: the refusal is not shown.
        let refuse: (error: unknown) => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve({ available: true, missing: [] });
            if (method === "voiceStart") return new Promise<void>((_resolve, reject) => (refuse = reject));
            return Promise.resolve(undefined);
        });
        act(() => {
            starting = view.result.current.voice.start();
        });
        await waitFor(() => expect(calls("voiceStart")).toHaveLength(2));
        act(() => view.result.current.voice.stop());
        await act(async () => {
            refuse({ code: "failed" });
            await starting;
        });
        expect(view.result.current.voice.error).toBeNull();

        // Cancelled during the download.
        let finishInstall: (value: unknown) => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve({ available: false, missing: ["eou"], downloadBytes: 1 });
            if (method === "voiceInstall") return new Promise((resolve) => (finishInstall = resolve));
            return Promise.resolve(undefined);
        });
        await act(() => view.result.current.voice.start());
        let installing: Promise<void> = Promise.resolve();
        act(() => {
            installing = view.result.current.voice.install();
        });
        act(() => view.result.current.voice.stop());
        emit({ type: "install", fraction: 0.9 });
        await act(async () => {
            finishInstall({ available: true });
            await installing;
        });
        expect(view.result.current.voice.phase).toBe("off");
        expect(view.result.current.voice.installProgress).toBeNull();
    });

    it("ignores a vocabulary that finishes loading after voice mode was ended", async () => {
        const vocabulary = await import("@/app/lib/voice/dictationVocabulary");
        let finishLoad: () => void = () => undefined;
        vi.mocked(vocabulary.loadUserVocabulary).mockImplementationOnce(
            () => new Promise((resolve) => (finishLoad = () => resolve([]))),
        );
        const view = renderVoiceChat();
        let starting: Promise<void> = Promise.resolve();
        act(() => {
            starting = view.result.current.voice.start();
        });
        await waitFor(() => expect(view.result.current.voice.phase).toBe("starting"));
        act(() => view.result.current.voice.stop());
        await act(async () => {
            finishLoad();
            await starting;
        });
        expect(calls("voiceStart")).toEqual([]);
    });

    it("stops and releases the microphone on unmount and when the thread changes", async () => {
        const view = await started();
        view.rerender({ chatId: "chat-2" });
        expect(view.result.current.voice.phase).toBe("off");
        expect(calls("voiceStop")).toHaveLength(1);
        expect(remove).toHaveBeenCalled();
        await act(() => view.result.current.voice.start());
        view.unmount();
        expect(calls("voiceStop")).toHaveLength(2);
    });

    it("carries on in the chat its first turn created on the new-chat screen", async () => {
        const view = await started({ chatId: null });
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        expect(view.sent).toEqual(["what notice"]);
        // The server created the chat for that turn; the page adopts its id.
        view.rerender({ chatId: "chat-new" });
        expect(view.result.current.voice.phase).toBe("on");
        expect(calls("voiceStop")).toEqual([]);
        view.stream(ANSWER.slice(0, 120));
        expect(calls("voiceSpeak")).not.toHaveLength(0);
        // What was heard is recorded against the adopted chat.
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "bargeIn", turnId: "t1" });
        expect(recordMock).toHaveBeenCalledWith("chat-new", "a1", "Under the lease, the tenant must give");
        // Only that one chat: moving on from it ends voice mode as usual.
        view.rerender({ chatId: "chat-other" });
        expect(view.result.current.voice.phase).toBe("off");
    });

    it("ends voice mode on the new-chat screen when another chat opens before a turn is sent", async () => {
        const view = await started({ chatId: null });
        view.rerender({ chatId: "chat-2" });
        expect(view.result.current.voice.phase).toBe("off");
        expect(calls("voiceStop")).toHaveLength(1);
    });

    it("reports the models preparing for first use while starting, from the status and the engine's events", async () => {
        status = { available: true, missing: [], downloadBytes: 0, preparing: true, firstTime: true, ready: [] };
        let finishStart: () => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve(status);
            if (method === "voiceStart") return new Promise<void>((resolve) => (finishStart = resolve));
            return Promise.resolve(undefined);
        });
        const view = renderVoiceChat();
        expect(view.result.current.voice.preparation).toEqual({ preparing: false, firstTime: false });
        let starting: Promise<void> = Promise.resolve();
        act(() => {
            starting = view.result.current.voice.start();
        });
        await waitFor(() => expect(view.result.current.voice.phase).toBe("starting"));
        expect(view.result.current.voice.preparation).toEqual({ preparing: true, firstTime: true });
        await waitFor(() => expect(calls("voiceStart")).toHaveLength(1));
        emit({ type: "preparation", preparing: false, firstTime: false, ready: ["vad"] });
        expect(view.result.current.voice.preparation).toEqual({ preparing: false, firstTime: false });
        await act(async () => {
            finishStart();
            await starting;
        });
        expect(view.result.current.voice.phase).toBe("on");
    });

    it("ends voice mode when leaving a chat for the new-chat screen", async () => {
        const view = await started();
        view.rerender({ chatId: null });
        expect(view.result.current.voice.phase).toBe("off");
    });

    it("ignores a late `ended` from the session before, and releases an engine that started after an end (W1)", async () => {
        const starts: (() => void)[] = [];
        nativePromise.mockImplementation((_plugin: string, method: string) => {
            if (method === "voiceStatus") return Promise.resolve(status);
            if (method === "voiceStart") return new Promise<void>((resolve) => starts.push(resolve));
            return Promise.resolve(undefined);
        });
        const view = renderVoiceChat();
        let first: Promise<void> = Promise.resolve();
        act(() => {
            first = view.result.current.voice.start();
        });
        await waitFor(() => expect(starts).toHaveLength(1));
        act(() => view.result.current.voice.stop());
        let second: Promise<void> = Promise.resolve();
        act(() => {
            second = view.result.current.voice.start();
        });
        await waitFor(() => expect(starts).toHaveLength(2));
        // The first session's stop reports `ended` while the second starts.
        emit({ type: "ended", reason: "stopped" });
        expect(view.result.current.voice.phase).toBe("starting");
        // The first start resolves late: a newer start is on its way, so it is left alone.
        await act(async () => {
            starts[0]();
            await first;
        });
        expect(calls("voiceStop")).toHaveLength(1);
        await act(async () => {
            starts[1]();
            await second;
        });
        expect(view.result.current.voice.phase).toBe("on");
        expect(view.result.current.voice.announcement).toBe("Voice mode on");

        // Ended for good while the engine starts: the engine is released once it has.
        act(() => view.result.current.voice.stop());
        expect(view.result.current.voice.announcement).toBe("Voice mode ended");
        let third: Promise<void> = Promise.resolve();
        act(() => {
            third = view.result.current.voice.start();
        });
        await waitFor(() => expect(starts).toHaveLength(3));
        act(() => view.result.current.voice.stop());
        const stops = calls("voiceStop").length;
        await act(async () => {
            starts[2]();
            await third;
        });
        expect(calls("voiceStop")).toHaveLength(stops + 1);
        expect(view.result.current.voice.phase).toBe("off");
    });

    it("never drops words spoken over before they were sent: they open the next turn (W2)", async () => {
        const view = await started();
        act(() => view.result.current.setLoading(true));
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        emit({ type: "bargeIn", turnId: "t1" });
        emit({ type: "turn", turnId: "t2", text: "does the tenant owe", audioMs: 900 });
        view.finish();
        await waitFor(() => expect(view.sent).toEqual(["what notice does the tenant owe"]));
        expect(recordMock).not.toHaveBeenCalled();
    });

    it("sends the next turn only once what was heard of the last answer is recorded (W3)", async () => {
        let finishRecord: () => void = () => undefined;
        recordMock.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRecord = resolve)));
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "bargeIn", turnId: "t1" });
        expect(recordMock).toHaveBeenCalledTimes(1);
        emit({ type: "turn", turnId: "t2", text: "second question", audioMs: 900 });
        await act(async () => undefined);
        expect(view.sent).toEqual(["first question"]);
        await act(async () => finishRecord());
        await waitFor(() => expect(view.sent).toEqual(["first question", "second question"]));
    });

    it("sends the next turn anyway when recording takes too long (W3)", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        recordMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "interrupted", turnId: "t1", clauseId: 0, fraction: 0.5 });
        emit({ type: "turn", turnId: "t2", text: "second question", audioMs: 900 });
        await act(async () => undefined);
        expect(view.sent).toEqual(["first question"]);
        await act(async () => {
            vi.advanceTimersByTime(RECORD_WAIT_MS);
        });
        expect(view.sent).toEqual(["first question", "second question"]);
    });

    it("hears an `interrupted` for the turn before after the next has begun", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clauseStarted", turnId: "t1", clauseId: 0 });
        emit({ type: "bargeIn", turnId: "t1" });
        emit({ type: "turn", turnId: "t2", text: "second question", audioMs: 900 });
        emit({ type: "interrupted", turnId: "t1", clauseId: 0, fraction: 0.3 });
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "Under the");
        await waitFor(() => expect(view.sent).toEqual(["first question", "second question"]));
    });

    it("ending voice mode mid-answer records where speech stopped, then releases the engine (W4)", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "clauseStarted", turnId: "t1", clauseId: 1 });
        let finishCancel: () => void = () => undefined;
        nativePromise.mockImplementation((_plugin: string, method: string) =>
            method === "voiceCancelAnswer" ? new Promise<void>((resolve) => (finishCancel = resolve)) : Promise.resolve(undefined),
        );
        act(() => view.result.current.voice.stop());
        expect(view.result.current.voice.phase).toBe("off");
        expect(calls("voiceCancelAnswer")).toEqual([{ turnId: "t1" }]);
        expect(calls("voiceStop")).toEqual([]);
        // The engine reports where it stopped as it cancels.
        act(() => emitNative?.({ type: "interrupted", turnId: "t1", clauseId: 1, fraction: 0.7 }));
        await act(async () => finishCancel());
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "Under the lease, the tenant must give **ninety days'** written");
        await waitFor(() => expect(calls("voiceStop")).toHaveLength(1));
        expect(view.cancelResponse).not.toHaveBeenCalled();
    });

    it("ending mid-answer without an `interrupted` records the clauses that played (W4)", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const view = renderVoiceChat();
        await act(() => view.result.current.voice.start());
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream(ANSWER.slice(0, 120));
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "clauseStarted", turnId: "t1", clauseId: 1 });
        act(() => view.result.current.voice.stop());
        await act(async () => undefined);
        // Another turn's `interrupted` is not this one's.
        act(() => emitNative?.({ type: "interrupted", turnId: "other", clauseId: 0, fraction: 1 }));
        expect(recordMock).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(INTERRUPT_WAIT_MS);
        });
        expect(recordMock).toHaveBeenCalledWith("chat-1", "a1", "Under the lease, the tenant must give");
        expect(calls("voiceStop")).toHaveLength(1);
    });

    it("ending voice mode after the answer was spoken records nothing", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
        view.stream(ANSWER);
        view.finish();
        emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
        emit({ type: "answerFinished", turnId: "t1" });
        act(() => view.result.current.voice.stop());
        expect(calls("voiceStop")).toHaveLength(1);
        expect(calls("voiceCancelAnswer")).toEqual([]);
        expect(recordMock).not.toHaveBeenCalled();
    });

    it("never splits a citation across clauses (W5)", async () => {
        const view = await started();
        emit({ type: "turn", turnId: "t1", text: "can they dismiss", audioMs: 900 });
        view.stream("Dismissal under Fed. R. Civ. P. 12(b)(6) requires plausible facts, as the Court held.");
        view.finish();
        expect(calls("voiceSpeak").map((call) => (call as { text: string }).text)).toEqual([
            "Dismissal under Federal Rule of Civil Procedure twelve b six,",
            "requires plausible facts, as the Court held.",
        ]);
    });

    describe("a turn the person went on from (`continues`)", () => {
        it("replaces the words of a turn not yet sent, and sends them once", async () => {
            const view = await started({ replace: true });
            act(() => view.result.current.setLoading(true));
            emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
            emit({ type: "bargeIn", turnId: "t1" });
            emit({ type: "turn", turnId: "t2", text: "what notice does the tenant owe", audioMs: 1900, continues: "t1" });
            view.finish();
            await waitFor(() => expect(view.sent).toEqual(["what notice does the tenant owe"]));
            expect(view.replaced).toEqual([]);
        });

        it("keeps the words carried into the turn it continues", async () => {
            const view = await started({ replace: true });
            act(() => view.result.current.setLoading(true));
            emit({ type: "turn", turnId: "t1", text: "the lease", audioMs: 900 });
            emit({ type: "bargeIn", turnId: "t1" });
            emit({ type: "turn", turnId: "t2", text: "what notice", audioMs: 900 });
            emit({ type: "turn", turnId: "t3", text: "what notice does the tenant owe", audioMs: 1900, continues: "t2" });
            view.finish();
            await waitFor(() => expect(view.sent).toEqual(["the lease what notice does the tenant owe"]));
        });

        it("replaces a sent prompt with the whole of what was said, without waiting for the abandoned answer's record", async () => {
            recordMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
            const view = await started({ replace: true });
            emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
            view.namePrompt("u1");
            view.stream(ANSWER.slice(0, 120));
            emit({ type: "clausePlayed", turnId: "t1", clauseId: 0 });
            emit({ type: "bargeIn", turnId: "t1" });
            expect(view.cancelResponse).toHaveBeenCalledTimes(1);
            emit({ type: "turn", turnId: "t2", text: "what notice does ximena acterberg owe", audioMs: 1900, continues: "t1" });
            await waitFor(() => expect(view.replaced).toEqual([["u1", "what notice does Ximena Achterberg owe"]]));
            expect(view.sent).toEqual(["what notice"]);
            // The new version's answer is spoken as that turn's.
            view.stream(ANSWER.slice(0, 120), "a2");
            await waitFor(() => expect(calls("voiceSpeak")).toContainEqual(expect.objectContaining({ turnId: "t2" })));
        });

        it("sends a continuation of a turn it does not know as a new turn", async () => {
            const view = await started({ replace: true });
            emit({ type: "turn", turnId: "t1", text: "first question", audioMs: 900 });
            view.namePrompt("u1");
            view.stream(ANSWER.slice(0, 50));
            emit({ type: "turn", turnId: "t2", text: "second question", audioMs: 900, continues: "t0" });
            await waitFor(() => expect(view.sent).toEqual(["first question", "second question"]));
            expect(view.replaced).toEqual([]);
        });

        it("sends the whole of what was said as a new turn without a way to replace the prompt", async () => {
            const view = await started();
            emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
            view.namePrompt("u1");
            emit({ type: "bargeIn", turnId: "t1" });
            emit({ type: "turn", turnId: "t2", text: "what notice does the tenant owe", audioMs: 1900, continues: "t1" });
            await waitFor(() => expect(view.sent).toEqual(["what notice", "what notice does the tenant owe"]));
        });

        it("sends it as a new turn before the chat has named the prompt", async () => {
            const view = await started({ replace: true });
            emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
            emit({ type: "bargeIn", turnId: "t1" });
            emit({ type: "turn", turnId: "t2", text: "what notice does the tenant owe", audioMs: 1900, continues: "t1" });
            await waitFor(() => expect(view.sent).toEqual(["what notice", "what notice does the tenant owe"]));
            expect(view.replaced).toEqual([]);
        });

        it("sends it as a new turn when the prompt could not be replaced", async () => {
            const view = await started({ replace: "reject" });
            emit({ type: "turn", turnId: "t1", text: "what notice", audioMs: 900 });
            view.namePrompt("u1");
            emit({ type: "bargeIn", turnId: "t1" });
            emit({ type: "turn", turnId: "t2", text: "what notice does the tenant owe", audioMs: 1900, continues: "t1" });
            await waitFor(() => expect(view.sent).toEqual(["what notice", "what notice does the tenant owe"]));
            expect(view.result.current.voice.error).toBeNull();
        });
    });

    it("marks voice mode on for the page while it runs, so read-aloud stays silent", async () => {
        const view = renderVoiceChat();
        expect(voiceModeActive()).toBe(false);
        await act(() => view.result.current.voice.start());
        expect(voiceModeActive()).toBe(true);
        act(() => view.result.current.voice.stop());
        expect(voiceModeActive()).toBe(false);
    });

    it("maps engine states to what the screen says", () => {
        expect(activityOf("listening")).toBe("listening");
        expect(activityOf("user-speaking")).toBe("listening");
        expect(activityOf("confirming-end")).toBe("listening");
        expect(activityOf("thinking")).toBe("thinking");
        expect(activityOf("speaking")).toBe("speaking");
    });
});
