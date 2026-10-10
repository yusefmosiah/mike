import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY, useIsDesktop } from "./useIsDesktop";

/** A matchMedia whose answer the test can change, notifying listeners. */
function stubMatchMedia(initial: boolean) {
    let matches = initial;
    const listeners = new Set<() => void>();
    const matchMedia = vi.fn((query: string) => ({
        get matches() {
            return query === DESKTOP_QUERY ? matches : false;
        },
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    return {
        set(next: boolean) {
            matches = next;
            listeners.forEach((listener) => listener());
        },
        listeners,
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("useIsDesktop", () => {
    it("follows the md breakpoint as the window crosses it", () => {
        const media = stubMatchMedia(false);
        const { result, unmount } = renderHook(() => useIsDesktop());
        expect(result.current).toBe(false);
        act(() => media.set(true));
        expect(result.current).toBe(true);
        unmount();
        expect(media.listeners.size).toBe(0);
    });

    it("reports desktop where matchMedia does not exist", () => {
        vi.stubGlobal("matchMedia", undefined);
        const { result } = renderHook(() => useIsDesktop());
        expect(result.current).toBe(true);
    });
});
