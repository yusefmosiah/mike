/**
 * The visible, scrollable area a chat thread is measured against.
 *
 * On a phone the thread scrolls the page itself rather than a box inside it:
 * that is what lets a tap on the status bar scroll it to the top, in Safari
 * and in the iPhone app alike. Elsewhere it scrolls inside its own container.
 * Callers pass the container and get whichever of the two is scrolling.
 */
export interface ScrollViewport {
    /** How far the content is scrolled. */
    readonly scrollTop: number;
    /** Height of the visible area. */
    readonly height: number;
    /** Height of everything that can be scrolled. */
    readonly scrollHeight: number;
    /** Top edge of the visible area, in viewport coordinates. */
    readonly top: number;
    scrollTo(options: ScrollToOptions): void;
}

/**
 * Inside a layout that lets the page scroll (`data-document-scroll`), a
 * container whose overflow is `visible` does not scroll: the page does. On
 * wider screens the same container scrolls itself.
 */
export function scrollsWithPage(container: Element): boolean {
    return (
        container.closest("[data-document-scroll]") !== null &&
        getComputedStyle(container).overflowY === "visible"
    );
}

/**
 * Whether the viewport is stretched past either end, as during a rubber-band
 * bounce on an Apple device (WebKit reports a negative scrollTop, or one past
 * the end, while the content is pulled and while it springs back). Writing
 * scrollTop then cancels the bounce, so automatic scrolling must wait.
 */
export function isOverscrolled(viewport: Pick<ScrollViewport, "scrollTop" | "height" | "scrollHeight">): boolean {
    const end = Math.max(0, viewport.scrollHeight - viewport.height);
    return viewport.scrollTop < -0.5 || viewport.scrollTop > end + 0.5;
}

/** Each measurement is read when asked for: reading layout is not free. */
export function scrollViewportOf(container: HTMLElement): ScrollViewport {
    if (!scrollsWithPage(container)) {
        return {
            get scrollTop() {
                return container.scrollTop;
            },
            get height() {
                return container.clientHeight;
            },
            get scrollHeight() {
                return container.scrollHeight;
            },
            get top() {
                return container.getBoundingClientRect().top;
            },
            scrollTo: (options) => container.scrollTo(options),
        };
    }
    const page = document.scrollingElement ?? document.documentElement;
    return {
        get scrollTop() {
            return page.scrollTop;
        },
        // The visible height, which on iOS changes as Safari's bars collapse.
        get height() {
            return window.innerHeight;
        },
        get scrollHeight() {
            return page.scrollHeight;
        },
        top: 0,
        scrollTo: (options) => window.scrollTo(options),
    };
}

/** Calls `listener` when either the container or the page scrolls or resizes. */
export function onScrollViewportChange(container: HTMLElement, listener: () => void): () => void {
    container.addEventListener("scroll", listener, { passive: true });
    window.addEventListener("scroll", listener, { passive: true });
    window.addEventListener("resize", listener);
    return () => {
        container.removeEventListener("scroll", listener);
        window.removeEventListener("scroll", listener);
        window.removeEventListener("resize", listener);
    };
}

/** A padding in pixels as laid out, which may include a safe-area inset. */
export function computedPadding(element: Element, side: "top" | "bottom", fallback: number): number {
    const value = parseFloat(getComputedStyle(element)[side === "top" ? "paddingTop" : "paddingBottom"]);
    return Number.isFinite(value) ? value : fallback;
}
