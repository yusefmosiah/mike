import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScreenWakeLock } from "./useScreenWakeLock";

function stubWakeLock(request: () => Promise<{ release: () => Promise<void> }>) {
    Object.defineProperty(navigator, "wakeLock", { value: { request: vi.fn(request) }, configurable: true });
    return (navigator as unknown as { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock.request;
}

afterEach(() => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

describe("useScreenWakeLock", () => {
    it("holds the screen on while active and lets go after", async () => {
        const release = vi.fn(async () => undefined);
        const request = stubWakeLock(async () => ({ release }));
        const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: false } });
        expect(request).not.toHaveBeenCalled();
        rerender({ active: true });
        expect(request).toHaveBeenCalledWith("screen");
        await vi.waitFor(() => expect(release).not.toHaveBeenCalled());
        await Promise.resolve();
        rerender({ active: false });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("lets go of a lock granted after it stopped being wanted", async () => {
        const release = vi.fn(async () => undefined);
        let grant: (value: { release: () => Promise<void> }) => void = () => undefined;
        stubWakeLock(() => new Promise((resolve) => (grant = resolve)));
        const { unmount } = renderHook(() => useScreenWakeLock(true));
        unmount();
        grant({ release });
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it("does nothing where there is no wake lock, or it is refused", async () => {
        const { unmount } = renderHook(() => useScreenWakeLock(true));
        unmount();
        const request = stubWakeLock(async () => {
            throw new Error("NotAllowedError");
        });
        const second = renderHook(() => useScreenWakeLock(true));
        await vi.waitFor(() => expect(request).toHaveBeenCalled());
        second.unmount();
    });
});
