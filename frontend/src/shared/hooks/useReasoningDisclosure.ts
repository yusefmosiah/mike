import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type WindowScroll = "start" | "middle" | "end";

/** Disclosure behavior shared by web and Word reasoning blocks. */
export function useReasoningDisclosure(isStreaming: boolean) {
    // A thought starts closed: its line (the step summary, or a thinking
    // phrase while it streams) is what a reader follows, and the thinking
    // itself opens only when they ask for it. Each thought opens on its own;
    // opening one does not open the next.
    const [isContentOpen, setIsContentOpen] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const overflowingRef = useRef(false);
    const contentRef = useRef<HTMLDivElement | null>(null);
    // The collapsed window scrolls. While the thought streams it stays on the
    // newest lines, unless the reader scrolls up inside it; scrolling back to
    // its end resumes following.
    const windowRef = useRef<HTMLDivElement | null>(null);
    const followRef = useRef(true);
    const lastScrollTopRef = useRef(0);
    const streamingRef = useRef(isStreaming);
    const [windowScroll, setWindowScroll] = useState<WindowScroll>("start");
    const windowScrollRef = useRef<WindowScroll>("start");

    useEffect(() => {
        streamingRef.current = isStreaming;
    }, [isStreaming]);

    const readWindowScroll = useCallback((element: HTMLDivElement) => {
        const fromEnd =
            element.scrollHeight - element.scrollTop - element.clientHeight;
        const next: WindowScroll =
            fromEnd <= 2 ? "end" : element.scrollTop <= 2 ? "start" : "middle";
        if (next === windowScrollRef.current) return;
        windowScrollRef.current = next;
        setWindowScroll(next);
    }, []);

    const followEnd = useCallback(() => {
        const element = windowRef.current;
        if (!element || !streamingRef.current || !followRef.current) return;
        element.scrollTop = element.scrollHeight;
        readWindowScroll(element);
    }, [readWindowScroll]);

    const attachWindow = useCallback(
        (element: HTMLDivElement | null) => {
            windowRef.current = element;
            lastScrollTopRef.current = element?.scrollTop ?? 0;
            if (!element) {
                windowScrollRef.current = "start";
                return;
            }
            followEnd();
        },
        [followEnd],
    );

    // The window starts clipping once the text overflows, or again when the
    // reader minimises it: show the newest lines from that first frame.
    useLayoutEffect(() => {
        const element = windowRef.current;
        if (!element) return;
        followEnd();
        readWindowScroll(element);
    }, [isContentOpen, isOverflowing, isExpanded, followEnd, readWindowScroll]);

    // Only the reader scrolls the window up. Reading the distance from the
    // end alone would mistake a line that arrived before this scroll event
    // for the reader leaving.
    const onWindowScroll = useCallback(() => {
        const element = windowRef.current;
        if (!element) return;
        const top = element.scrollTop;
        if (top < lastScrollTopRef.current - 1) followRef.current = false;
        if (element.scrollHeight - top - element.clientHeight <= 4) {
            followRef.current = true;
        }
        lastScrollTopRef.current = top;
        readWindowScroll(element);
    }, [readWindowScroll]);

    useEffect(() => {
        const element = contentRef.current;
        if (!isContentOpen || !element) return;

        let frame: number | null = null;
        let disposed = false;
        const measure = () => {
            frame = null;
            if (disposed) return;
            const lineHeight =
                parseFloat(getComputedStyle(element).lineHeight) || 24;
            const next = element.scrollHeight > lineHeight * 6 + 2;
            // Guard before dispatch, rather than relying on a setState bailout
            // while concurrent streaming work may already be queued.
            if (next === overflowingRef.current) return;
            overflowingRef.current = next;
            // Expanded stays as the reader set it: a thought that starts
            // short and grows keeps opening in full.
            setIsOverflowing(next);
        };
        const scheduleMeasure = () => {
            if (!disposed && frame === null) {
                frame = requestAnimationFrame(measure);
            }
        };

        scheduleMeasure();
        // Observe the natural content, not its clipped wrapper. This covers
        // streamed text, width changes and font loading without text effects.
        // Following runs here rather than in the frame: the observer fires
        // after layout and before paint, so new lines never show clipped.
        const observer = new ResizeObserver(() => {
            followEnd();
            scheduleMeasure();
        });
        observer.observe(element);
        return () => {
            disposed = true;
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [isContentOpen, followEnd]);

    return {
        contentRef,
        /** Ref for the collapsed window, the element that clips and scrolls. */
        windowRef: attachWindow,
        onWindowScroll,
        /** Which edges of the collapsed window have hidden text past them. */
        windowScroll,
        isContentOpen,
        isExpanded,
        isOverflowing,
        setIsExpanded,
        // Opened while it streams, a thought shows its newest lines in the
        // collapsed window; opened once finished, all of it.
        toggleContent: () => {
            const open = !isContentOpen;
            setIsContentOpen(open);
            if (open) setIsExpanded(!isStreaming);
        },
    };
}
