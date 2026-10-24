import { afterEach, describe, expect, it, vi } from "vitest";
import { watchHorizontalSwipe } from "./horizontalSwipe";

function touch(target: EventTarget, type: string, points: Array<[number, number]>) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    });
    target.dispatchEvent(event);
}

function swipe(target: EventTarget, path: Array<[number, number]>) {
    touch(target, "touchstart", [path[0]]);
    for (const point of path.slice(1)) touch(target, "touchmove", [point]);
    touch(target, "touchend", []);
}

const page = () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    return element;
};

afterEach(() => {
    document.body.innerHTML = "";
});

describe("watchHorizontalSwipe", () => {
    it("fires once for a swipe in its direction", () => {
        const target = page();
        const onSwipe = vi.fn();
        watchHorizontalSwipe(target, { direction: "right", onSwipe });

        swipe(target, [[20, 300], [50, 305], [90, 308], [140, 310]]);

        expect(onSwipe).toHaveBeenCalledTimes(1);
    });

    it("hears a left swipe, and ignores the other direction", () => {
        const target = page();
        const onSwipe = vi.fn();
        watchHorizontalSwipe(target, { direction: "left", onSwipe, minDistance: 40 });

        swipe(target, [[200, 300], [250, 300]]);
        expect(onSwipe).not.toHaveBeenCalled();

        swipe(target, [[200, 300], [150, 300]]);
        expect(onSwipe).toHaveBeenCalledTimes(1);
    });

    it("leaves a scroll alone, even one that drifts sideways later", () => {
        const target = page();
        const onSwipe = vi.fn();
        watchHorizontalSwipe(target, { direction: "right", onSwipe });

        swipe(target, [[20, 300], [25, 260], [120, 250]]);
        // Mostly sideways, but too steep to read as a swipe.
        swipe(target, [[20, 300], [90, 340]]);

        expect(onSwipe).not.toHaveBeenCalled();
    });

    it("ignores moves with no touch started, multi-touch and a disabled state", () => {
        const target = page();
        const onSwipe = vi.fn();
        let enabled = false;
        watchHorizontalSwipe(target, { direction: "right", onSwipe, enabled: () => enabled });

        touch(target, "touchmove", [[200, 300]]);
        swipe(target, [[20, 300], [140, 300]]);
        enabled = true;
        touch(target, "touchstart", [[20, 300], [60, 300]]);
        touch(target, "touchmove", [[140, 300]]);
        touch(target, "touchcancel", []);
        touch(target, "touchmove", [[160, 300]]);

        expect(onSwipe).not.toHaveBeenCalled();
    });

    it("does not start in fields or in things that scroll sideways themselves", () => {
        const target = page();
        const onSwipe = vi.fn();
        watchHorizontalSwipe(target, { direction: "right", onSwipe });

        const field = document.createElement("textarea");
        const wide = document.createElement("div");
        wide.style.overflowX = "auto";
        Object.defineProperties(wide, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
        const cell = document.createElement("span");
        wide.appendChild(cell);
        const fits = document.createElement("div");
        fits.style.overflowX = "scroll";
        Object.defineProperties(fits, { scrollWidth: { value: 300 }, clientWidth: { value: 300 } });
        target.append(field, wide, fits);

        swipe(field, [[20, 300], [140, 300]]);
        swipe(cell, [[20, 300], [140, 300]]);
        expect(onSwipe).not.toHaveBeenCalled();

        // A box that could scroll but has nothing to scroll does not count.
        swipe(fits, [[20, 300], [140, 300]]);
        expect(onSwipe).toHaveBeenCalledTimes(1);
    });

    it("starts from a non-element target, such as the window", () => {
        const onSwipe = vi.fn();
        const stop = watchHorizontalSwipe(window, { direction: "right", onSwipe });

        swipe(window, [[20, 300], [140, 300]]);
        expect(onSwipe).toHaveBeenCalledTimes(1);

        stop();
        swipe(window, [[20, 300], [140, 300]]);
        expect(onSwipe).toHaveBeenCalledTimes(1);
    });

    it("leaves a scoped surface to the watcher that names it", () => {
        const target = page();
        const panel = document.createElement("div");
        panel.setAttribute("data-swipe-scope", "panel");
        const inside = document.createElement("span");
        panel.appendChild(inside);
        target.appendChild(panel);
        const page_ = vi.fn();
        const owner = vi.fn();
        watchHorizontalSwipe(target, { direction: "right", onSwipe: page_ });
        watchHorizontalSwipe(panel, { direction: "right", onSwipe: owner, scope: "panel" });

        swipe(inside, [[20, 300], [140, 300]]);

        expect(page_).not.toHaveBeenCalled();
        expect(owner).toHaveBeenCalledTimes(1);
    });
});
