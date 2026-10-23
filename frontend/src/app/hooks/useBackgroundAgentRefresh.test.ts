import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDetailOut, Message } from "@/app/components/shared/types";
import { loadAssistantChat } from "@/app/lib/assistantTurns";
import {
    BACKGROUND_AGENT_POLL_MS,
    useBackgroundAgentRefresh,
} from "./useBackgroundAgentRefresh";

vi.mock("@/app/lib/assistantTurns", () => ({ loadAssistantChat: vi.fn() }));
const load = vi.mocked(loadAssistantChat);

const shown: Message[] = [
    { id: "u1", role: "user", content: "Question" },
    { id: "a1", role: "assistant", content: "Answer" },
];
const withReport: Message[] = [
    ...shown,
    { id: "u2", role: "user", content: "[Background subagents] …" },
];
const detail = (messages: Message[]) =>
    ({ chat: { id: "c1" }, messages }) as unknown as ChatDetailOut;

let visibility: "visible" | "hidden" = "visible";
function setVisibility(next: "visible" | "hidden") {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
}

type Options = Parameters<typeof useBackgroundAgentRefresh>[0];
function setup(overrides: Partial<Options> = {}) {
    const onRefreshed = vi.fn();
    const hook = renderHook(
        (options: Options) => useBackgroundAgentRefresh(options),
        {
            initialProps: {
                chatId: "c1",
                enabled: true,
                idle: true,
                messages: shown,
                onRefreshed,
                ...overrides,
            } as Options,
        },
    );
    return { ...hook, onRefreshed };
}

const tick = (ms = BACKGROUND_AGENT_POLL_MS) =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });

beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    load.mockReset();
    load.mockResolvedValue(detail(shown));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("useBackgroundAgentRefresh", () => {
    it("reads the chat every 15 seconds while enabled, visible and idle", async () => {
        setup();
        expect(load).not.toHaveBeenCalled();
        await tick();
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith("c1");
        await tick();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("hands over the read only when the server holds rows the page lacks", async () => {
        const { onRefreshed } = setup();
        await tick();
        expect(onRefreshed).not.toHaveBeenCalled();

        load.mockResolvedValue(detail(withReport));
        await tick();
        expect(onRefreshed).toHaveBeenCalledTimes(1);
        expect(onRefreshed.mock.calls[0][0].messages).toBe(withReport);
    });

    it("keeps an unsaved row on screen: only stored rows the page lacks count", async () => {
        const { onRefreshed } = setup({
            messages: [...shown, { role: "user", content: "Failed note", error: "Not added" }],
        });
        await tick();
        expect(onRefreshed).not.toHaveBeenCalled();
    });

    it("does nothing when the setting is off or there is no chat", async () => {
        setup({ enabled: false });
        setup({ chatId: null });
        await tick(BACKGROUND_AGENT_POLL_MS * 3);
        expect(load).not.toHaveBeenCalled();
    });

    it("does not poll while an answer is streaming, and resumes when it ends", async () => {
        const { rerender, onRefreshed } = setup({ idle: false });
        await tick(BACKGROUND_AGENT_POLL_MS * 3);
        expect(load).not.toHaveBeenCalled();

        rerender({ chatId: "c1", enabled: true, idle: true, messages: shown, onRefreshed });
        await tick();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("stops while the tab is hidden, and reads at once when it is shown again", async () => {
        setup();
        act(() => setVisibility("hidden"));
        await tick(BACKGROUND_AGENT_POLL_MS * 3);
        expect(load).not.toHaveBeenCalled();

        await act(async () => setVisibility("visible"));
        expect(load).toHaveBeenCalledTimes(1);
        await tick();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("reads when the window regains focus, but not while the tab is hidden", async () => {
        setup();
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(load).toHaveBeenCalledTimes(1);

        visibility = "hidden";
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("drops a read that lands after an answer started streaming here", async () => {
        let finish!: (value: ChatDetailOut) => void;
        load.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const { rerender, onRefreshed } = setup();
        await tick();
        rerender({ chatId: "c1", enabled: true, idle: false, messages: shown, onRefreshed });
        await act(async () => finish(detail(withReport)));
        expect(onRefreshed).not.toHaveBeenCalled();
    });

    it("does not start a second read while one is in flight", async () => {
        load.mockReturnValue(new Promise(() => {}));
        setup();
        await tick(BACKGROUND_AGENT_POLL_MS * 3);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("survives a failed read and tries again", async () => {
        load.mockRejectedValueOnce(new Error("offline"));
        setup();
        await tick();
        await tick();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("stops polling when unmounted", async () => {
        const { unmount } = setup();
        unmount();
        await tick(BACKGROUND_AGENT_POLL_MS * 3);
        expect(load).not.toHaveBeenCalled();
    });
});
