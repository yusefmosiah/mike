import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDetailOut } from "@/app/components/shared/types";

const { getChatMock } = vi.hoisted(() => ({ getChatMock: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ getChat: getChatMock }));

import { useThreadGenerating } from "./useThreadGenerating";

const partner = { id: "partner", name: "The partner", email: "partner@example.com" };
const detail = (generating: ChatDetailOut["generating"]) =>
    ({ chat: { id: "chat-1" }, messages: [], active_turn: null, generating }) as unknown as ChatDetailOut;

async function tick(ms = 3000) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("useThreadGenerating", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        getChatMock.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("polls while a colleague generates, then hands over the fresh read", async () => {
        const onFinished = vi.fn();
        getChatMock
            .mockResolvedValueOnce(detail(partner))
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce(detail(null));
        const { result } = renderHook(() =>
            useThreadGenerating({ chatId: "chat-1", localTurnActive: false, onFinished }),
        );
        expect(result.current.generating).toBeNull();
        act(() => result.current.setGenerating("chat-1", partner));
        expect(result.current.generating).toEqual(partner);

        await tick();
        expect(getChatMock).toHaveBeenCalledWith("chat-1");
        expect(result.current.generating).toEqual(partner);
        await tick();
        expect(result.current.generating).toEqual(partner);
        await tick();
        expect(result.current.generating).toBeNull();
        expect(onFinished).toHaveBeenCalledWith(detail(null));

        await tick();
        expect(getChatMock).toHaveBeenCalledTimes(3);
    });

    it("skips a tick while the previous read is still outstanding", async () => {
        let resolve: (value: ChatDetailOut) => void = () => {};
        getChatMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
        const { result } = renderHook(() =>
            useThreadGenerating({ chatId: "chat-1", localTurnActive: false, onFinished: vi.fn() }),
        );
        act(() => result.current.setGenerating("chat-1", partner));
        await tick();
        await tick();
        expect(getChatMock).toHaveBeenCalledTimes(1);
        await act(async () => resolve(detail(partner)));
    });

    it("keeps naming the holder while their turn streams here, and re-reads once that stream ends", async () => {
        const onFinished = vi.fn();
        const later = { ...detail(null), messages: [{ id: "u2", role: "user", content: "theirs" }] } as unknown as ChatDetailOut;
        getChatMock.mockResolvedValueOnce(detail(null)).mockResolvedValueOnce(later);
        const { result, rerender } = renderHook(
            ({ localTurnActive }) =>
                useThreadGenerating({ chatId: "chat-1", localTurnActive, onFinished, intervalMs: 1000 }),
            { initialProps: { localTurnActive: true } },
        );
        act(() => result.current.setGenerating("chat-1", partner));
        expect(result.current.generating).toEqual(partner);
        await tick(1000);
        expect(result.current.generating).toBeNull();
        expect(onFinished).not.toHaveBeenCalled();

        rerender({ localTurnActive: false });
        await tick(0);
        expect(onFinished).toHaveBeenCalledWith(later);
        await tick(1000);
        expect(getChatMock).toHaveBeenCalledTimes(2);
    });

    it("drops a deferred re-read that fails or lands after the page moved on", async () => {
        const onFinished = vi.fn();
        let resolve: (value: ChatDetailOut) => void = () => {};
        getChatMock
            .mockResolvedValueOnce(detail(null))
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce(detail(null))
            .mockReturnValueOnce(new Promise((r) => (resolve = r)));
        const { result, rerender, unmount } = renderHook(
            ({ localTurnActive }) =>
                useThreadGenerating({ chatId: "chat-1", localTurnActive, onFinished, intervalMs: 1000 }),
            { initialProps: { localTurnActive: true } },
        );
        act(() => result.current.setGenerating("chat-1", partner));
        await tick(1000);
        rerender({ localTurnActive: false });
        await tick(0);
        expect(onFinished).not.toHaveBeenCalled();

        rerender({ localTurnActive: true });
        act(() => result.current.setGenerating("chat-1", partner));
        await tick(1000);
        rerender({ localTurnActive: false });
        unmount();
        await act(async () => resolve(detail(null)));
        expect(onFinished).not.toHaveBeenCalled();
    });

    it("stays quiet for another chat, and once cleared", async () => {
        const { result, rerender, unmount } = renderHook(
            ({ chatId }) =>
                useThreadGenerating({ chatId, localTurnActive: false, onFinished: vi.fn(), intervalMs: 1000 }),
            { initialProps: { chatId: "chat-1" as string | null } },
        );
        act(() => result.current.setGenerating("chat-1", partner));
        rerender({ chatId: "chat-2" });
        expect(result.current.generating).toBeNull();
        await tick(1000);
        expect(getChatMock).not.toHaveBeenCalled();

        rerender({ chatId: null });
        act(() => result.current.setGenerating("chat-1", null));
        await tick(1000);
        expect(getChatMock).not.toHaveBeenCalled();
        unmount();
    });

    it("drops a read that lands after the page moved on", async () => {
        const onFinished = vi.fn();
        let resolve: (value: ChatDetailOut) => void = () => {};
        getChatMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
        const { result, unmount } = renderHook(() =>
            useThreadGenerating({ chatId: "chat-1", localTurnActive: false, onFinished }),
        );
        act(() => result.current.setGenerating("chat-1", partner));
        await tick();
        unmount();
        await act(async () => resolve(detail(null)));
        expect(onFinished).not.toHaveBeenCalled();
    });
});
