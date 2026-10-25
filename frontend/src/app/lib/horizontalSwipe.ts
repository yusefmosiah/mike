/**
 * A horizontal swipe, as phone apps use to reveal and dismiss a sidebar.
 *
 * Touch listeners are passive: a swipe is recognised alongside the page's
 * own scrolling, never instead of it. A gesture that turns vertical first is
 * a scroll and is ignored, as is one that starts in a field, on a slider or
 * in anything that scrolls sideways itself (a wide table, a code block) and
 * can still scroll the way the finger is going; a scroller already at its
 * edge in that direction does not hold the swipe back.
 *
 * A zone marked `data-swipe-edge="<scope>"` always starts that scope's
 * gesture, whatever lies beneath it. It is how a swipe begins over content
 * that never reports touches to this page (an iframe) or that scrolls.
 *
 * A surface that owns its own swipes (the document panel) marks itself with
 * `data-swipe-scope="<name>"`; watchers without that `scope` ignore touches
 * that start inside it, so two gestures never answer the same touch.
 */
export type SwipeDirection = "left" | "right";

export interface HorizontalSwipeOptions {
    direction: SwipeDirection;
    onSwipe: () => void;
    /** Checked when a touch starts. */
    enabled?: () => boolean;
    /** Horizontal travel, in CSS pixels, that counts as a swipe. */
    minDistance?: number;
    /** Names the surface this watcher belongs to; see `data-swipe-scope`. */
    scope?: string;
}

/** Vertical travel past which a gesture is a scroll, not a swipe. */
const SCROLL_SLOP = 12;

function startsInOwnGesture(
    target: EventTarget | null,
    scope: string | undefined,
    direction: SwipeDirection,
): boolean {
    for (let element = target instanceof Element ? target : null; element; element = element.parentElement) {
        if (scope !== undefined && element.getAttribute("data-swipe-edge") === scope) return false;
        const owner = element.getAttribute("data-swipe-scope");
        if (owner !== null && owner !== scope) return true;
        if (element.matches("input, textarea, select, [contenteditable='true']")) return true;
        const { overflowX } = getComputedStyle(element);
        if ((overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth) {
            // A right swipe scrolls content back toward its start; a left
            // swipe, on toward its end.
            const canScroll =
                direction === "right"
                    ? element.scrollLeft > 0
                    : element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
            if (canScroll) return true;
        }
    }
    return false;
}

/** Listens on `target` until the returned function is called. */
export function watchHorizontalSwipe(
    target: EventTarget,
    { direction, onSwipe, enabled = () => true, minDistance = 60, scope }: HorizontalSwipeOptions,
): () => void {
    let start: { x: number; y: number } | null = null;

    const onStart = (event: Event) => {
        const { touches } = event as TouchEvent;
        start =
            touches.length === 1 && enabled() && !startsInOwnGesture(event.target, scope, direction)
                ? { x: touches[0].clientX, y: touches[0].clientY }
                : null;
    };
    const onMove = (event: Event) => {
        if (!start) return;
        const touch = (event as TouchEvent).touches[0];
        const dx = (touch.clientX - start.x) * (direction === "right" ? 1 : -1);
        const dy = Math.abs(touch.clientY - start.y);
        if (dy > SCROLL_SLOP && dy > Math.abs(dx)) {
            start = null;
        } else if (dx >= minDistance && dx > dy * 2) {
            start = null;
            onSwipe();
        }
    };
    const onEnd = () => {
        start = null;
    };

    target.addEventListener("touchstart", onStart, { passive: true });
    target.addEventListener("touchmove", onMove, { passive: true });
    target.addEventListener("touchend", onEnd);
    target.addEventListener("touchcancel", onEnd);
    return () => {
        target.removeEventListener("touchstart", onStart);
        target.removeEventListener("touchmove", onMove);
        target.removeEventListener("touchend", onEnd);
        target.removeEventListener("touchcancel", onEnd);
    };
}
