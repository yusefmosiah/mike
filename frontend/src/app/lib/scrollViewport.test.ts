import { afterEach, describe, expect, it, vi } from "vitest";
import { computedPadding, isOverscrolled, onScrollViewportChange, scrollViewportOf, scrollsWithPage } from "./scrollViewport";

function box({ overflowY = "", scrollTop = 0, clientHeight = 0, scrollHeight = 0, top = 0, parent = document.body } = {}) {
    const element = document.createElement("div");
    if (overflowY) element.style.overflowY = overflowY;
    Object.defineProperties(element, {
        scrollTop: { value: scrollTop, configurable: true },
        clientHeight: { value: clientHeight },
        scrollHeight: { value: scrollHeight },
    });
    element.getBoundingClientRect = () => ({ top }) as DOMRect;
    element.scrollTo = vi.fn() as typeof element.scrollTo;
    parent.appendChild(element);
    return element;
}

/** A layout that lets the page scroll, as (pages)/layout.tsx marks it. */
function documentScrollLayout() {
    const layout = document.createElement("div");
    layout.dataset.documentScroll = "";
    document.body.appendChild(layout);
    return layout;
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("scrollViewportOf", () => {
    it("measures a container that scrolls itself", () => {
        const container = box({ overflowY: "auto", scrollTop: 40, clientHeight: 500, scrollHeight: 1200, top: 60 });
        expect(scrollsWithPage(container)).toBe(false);
        const viewport = scrollViewportOf(container);
        expect(viewport).toMatchObject({ scrollTop: 40, height: 500, scrollHeight: 1200, top: 60 });
        viewport.scrollTo({ top: 10 });
        expect(container.scrollTo).toHaveBeenCalledWith({ top: 10 });
    });

    it("scrolls itself outside a layout that lets the page scroll, whatever its overflow", () => {
        expect(scrollsWithPage(box({ overflowY: "visible" }))).toBe(false);
        expect(scrollsWithPage(box({ overflowY: "auto", parent: documentScrollLayout() }))).toBe(false);
    });

    it("measures the page when the container's overflow is visible", () => {
        const container = box({ overflowY: "visible", parent: documentScrollLayout() });
        const page = document.scrollingElement ?? document.documentElement;
        Object.defineProperties(page, {
            scrollTop: { value: 300, configurable: true },
            scrollHeight: { value: 4000, configurable: true },
        });
        const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        expect(scrollsWithPage(container)).toBe(true);
        const viewport = scrollViewportOf(container);
        expect(viewport).toMatchObject({ scrollTop: 300, height: window.innerHeight, scrollHeight: 4000, top: 0 });
        viewport.scrollTo({ top: 0 });
        expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });

    it("uses the document's scrolling element where the browser has one", () => {
        const page = document.createElement("div");
        Object.defineProperty(page, "scrollHeight", { value: 900 });
        Object.defineProperty(document, "scrollingElement", { value: page, configurable: true });
        try {
            expect(scrollViewportOf(box({ overflowY: "visible", parent: documentScrollLayout() })).scrollHeight).toBe(900);
        } finally {
            Reflect.deleteProperty(document, "scrollingElement");
        }
    });
});

describe("onScrollViewportChange", () => {
    it("hears the container and the page until stopped", () => {
        const container = box();
        const listener = vi.fn();
        const stop = onScrollViewportChange(container, listener);
        container.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("resize"));
        expect(listener).toHaveBeenCalledTimes(3);
        stop();
        container.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("resize"));
        expect(listener).toHaveBeenCalledTimes(3);
    });
});

describe("computedPadding", () => {
    it("reads the laid-out padding, or the fallback when there is none", () => {
        const element = box();
        element.style.paddingTop = "135px";
        element.style.paddingBottom = "128px";
        expect(computedPadding(element, "top", 76)).toBe(135);
        expect(computedPadding(element, "bottom", 116)).toBe(128);
        vi.spyOn(window, "getComputedStyle").mockReturnValue({ paddingTop: "" } as CSSStyleDeclaration);
        expect(computedPadding(box(), "top", 76)).toBe(76);
    });
});

describe("isOverscrolled", () => {
    const area = { height: 400, scrollHeight: 1000 };

    it("is false anywhere inside the scrollable range", () => {
        expect(isOverscrolled({ ...area, scrollTop: 0 })).toBe(false);
        expect(isOverscrolled({ ...area, scrollTop: 300 })).toBe(false);
        expect(isOverscrolled({ ...area, scrollTop: 600 })).toBe(false);
    });

    it("is true while stretched past the top or the end, as in a rubber-band bounce", () => {
        expect(isOverscrolled({ ...area, scrollTop: -12 })).toBe(true);
        expect(isOverscrolled({ ...area, scrollTop: 640 })).toBe(true);
    });

    it("treats content shorter than the viewport as having no range", () => {
        expect(isOverscrolled({ height: 400, scrollHeight: 300, scrollTop: 0 })).toBe(false);
        expect(isOverscrolled({ height: 400, scrollHeight: 300, scrollTop: 25 })).toBe(true);
    });
});
