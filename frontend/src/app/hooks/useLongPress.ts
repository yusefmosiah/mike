"use client";

import { useCallback, useEffect, useRef } from "react";
import type React from "react";

export const LONG_PRESS_MS = 500;
/** How far a finger may drift before the press counts as a scroll instead. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * Calls `onLongPress` when a finger rests on the element for `LONG_PRESS_MS`
 * without scrolling. Mouse presses are ignored: a mouse has hover controls.
 * `onLongPress` gets the pointer id, so the caller can ignore the release of
 * that same finger. Pass `enabled: false` to return no-op handlers.
 */
export function useLongPress(
    onLongPress: (pointerId: number) => void,
    enabled = true,
): LongPressHandlers {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startRef = useRef<{ x: number; y: number } | null>(null);
    const callbackRef = useRef(onLongPress);
    useEffect(() => {
        callbackRef.current = onLongPress;
    }, [onLongPress]);

    const cancel = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        startRef.current = null;
    }, []);
    useEffect(() => cancel, [cancel]);

    const onPointerDown = useCallback(
        (event: React.PointerEvent) => {
            if (!enabled || event.pointerType === "mouse") return;
            cancel();
            const { pointerId } = event;
            startRef.current = { x: event.clientX, y: event.clientY };
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                startRef.current = null;
                callbackRef.current(pointerId);
            }, LONG_PRESS_MS);
        },
        [enabled, cancel],
    );
    const onPointerMove = useCallback(
        (event: React.PointerEvent) => {
            const start = startRef.current;
            if (!start) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
        },
        [cancel],
    );
    // Android also reports a long press as a context menu; the timer has
    // already answered it, so the browser's own menu must not open too.
    const onContextMenu = useCallback(
        (event: React.MouseEvent) => {
            if (enabled) event.preventDefault();
        },
        [enabled],
    );

    return {
        onPointerDown,
        onPointerMove,
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onContextMenu,
    };
}
