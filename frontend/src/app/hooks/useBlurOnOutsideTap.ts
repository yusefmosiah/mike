"use client";

import { useEffect, type RefObject } from "react";

/** A touch that moves less than this, in CSS pixels, is a tap, not a drag. */
const TAP_SLOP = 10;
/** A touch held longer than this is a press, not a tap. */
const TAP_MS = 500;

/** Controls that act on a tap themselves: tapping one leaves the field focused. */
const CONTROL =
    'a, button, input, textarea, select, label, summary, [contenteditable="true"], [role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="option"], [role="listbox"], [role="dialog"], [role="tab"], [role="switch"], [role="checkbox"]';

/**
 * On a touch screen, a tap outside `container` while `field` is focused
 * blurs the field, which closes the keyboard. iOS does not do this itself
 * for a page in a web view, so without it only the keyboard's own controls
 * could close it. Drags (scrolling) and taps on links, buttons and other
 * controls are left alone; mouse and pen input never blur.
 */
export function useBlurOnOutsideTap(
    field: RefObject<HTMLElement | null>,
    container: RefObject<HTMLElement | null>,
): void {
    useEffect(() => {
        let start: { id: number; x: number; y: number; at: number } | null = null;

        const outside = (target: EventTarget | null) =>
            target instanceof Element &&
            !container.current?.contains(target) &&
            !target.closest(CONTROL);

        const onDown = (event: PointerEvent) => {
            start =
                event.pointerType === "touch" &&
                document.activeElement === field.current &&
                outside(event.target)
                    ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
                    : null;
        };
        const onUp = (event: PointerEvent) => {
            const tap = start;
            start = null;
            if (!tap || tap.id !== event.pointerId) return;
            if (Math.abs(event.clientX - tap.x) > TAP_SLOP || Math.abs(event.clientY - tap.y) > TAP_SLOP) return;
            if (event.timeStamp - tap.at > TAP_MS) return;
            if (document.activeElement === field.current) field.current?.blur();
        };
        const onCancel = () => {
            start = null;
        };

        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("pointerup", onUp, true);
        document.addEventListener("pointercancel", onCancel, true);
        return () => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("pointerup", onUp, true);
            document.removeEventListener("pointercancel", onCancel, true);
        };
    }, [field, container]);
}
