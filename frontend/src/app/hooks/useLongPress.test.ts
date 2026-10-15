import { renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS, useLongPress } from "./useLongPress";

const press = (pointerType: string, x = 0, y = 0) =>
    ({ pointerType, pointerId: 7, clientX: x, clientY: y }) as React.PointerEvent;

describe("useLongPress", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("fires for a finger held still, with its pointer id", () => {
        const onLongPress = vi.fn();
        const { result } = renderHook(() => useLongPress(onLongPress));
        result.current.onPointerDown(press("touch"));
        vi.advanceTimersByTime(LONG_PRESS_MS - 1);
        expect(onLongPress).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onLongPress).toHaveBeenCalledWith(7);
    });

    it("gives way to a scroll, a lift, a mouse, or being disabled", () => {
        const onLongPress = vi.fn();
        const { result, rerender } = renderHook(
            ({ enabled }) => useLongPress(onLongPress, enabled),
            { initialProps: { enabled: true } },
        );
        result.current.onPointerDown(press("touch"));
        result.current.onPointerMove(press("touch", 0, 20));
        result.current.onPointerDown(press("touch"));
        result.current.onPointerUp();
        result.current.onPointerDown(press("mouse"));
        rerender({ enabled: false });
        result.current.onPointerDown(press("touch"));
        vi.advanceTimersByTime(LONG_PRESS_MS * 2);
        expect(onLongPress).not.toHaveBeenCalled();
    });
});
