import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glide, KEYBOARD_EASING, watchNativeKeyboard } from "./nativeKeyboard";

let now = 1000;
let stop: () => void;
let dock: HTMLElement;

const keyboard = (open: boolean, duration = 300) =>
    window.dispatchEvent(new CustomEvent("mikekeyboard", { detail: { open, overlap: open ? 24 : 0, duration } }));
const resizeTo = (height: number) => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    window.dispatchEvent(new Event("resize"));
};

beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    resizeTo(900);
    document.body.innerHTML = '<div data-slot="chat-composer-dock"></div><div data-slot="chat-composer-fade"></div>';
    dock = document.querySelector('[data-slot="chat-composer-dock"]')!;
    stop = watchNativeKeyboard();
});

afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the iPhone app's keyboard", () => {
    it("marks the page while the keyboard is open, with how far it overlaps", () => {
        keyboard(true);
        expect(document.documentElement.dataset.keyboard).toBe("open");
        expect(document.documentElement.style.getPropertyValue("--keyboard-overlap")).toBe("24px");
        expect(document.documentElement.style.getPropertyValue("--keyboard-duration")).toBe("300ms");
        keyboard(false);
        expect(document.documentElement.dataset.keyboard).toBeUndefined();
        expect(document.documentElement.style.getPropertyValue("--keyboard-overlap")).toBe("0px");
        window.dispatchEvent(new CustomEvent("mikekeyboard"));
        stop();
        expect(document.documentElement.style.getPropertyValue("--keyboard-overlap")).toBe("");
        expect(document.documentElement.style.getPropertyValue("--keyboard-duration")).toBe("");
    });

    it("glides the composer from where it was, in the keyboard's remaining time", () => {
        keyboard(true, 300);
        now += 40;
        resizeTo(560);
        // It jumped up 340px with the viewport: it starts back down there.
        expect(dock.style.transition).toBe(`transform 260ms ${KEYBOARD_EASING}`);
        expect(dock.style.transform).toBe("");
        const fade = document.querySelector<HTMLElement>('[data-slot="chat-composer-fade"]')!;
        expect(fade.style.transition).toContain("260ms");
        vi.advanceTimersByTime(400);
        expect(dock.style.transition).toBe("");
    });

    it("pairs a resize that comes before the keyboard's event, and moves down when it closes", () => {
        resizeTo(560);
        now += 20;
        const glideSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
        keyboard(false, 250);
        expect(glideSpy).toHaveBeenCalled();
        expect(dock.style.transition).toBe(`transform 230ms ${KEYBOARD_EASING}`);
    });

    it("leaves alone a resize or event with no partner, or no time left", () => {
        resizeTo(560);
        now += 1000;
        keyboard(true, 300);
        expect(dock.style.transition).toBe("");
        // The stale keyboard event does not pair with a later resize either.
        now += 1000;
        resizeTo(900);
        expect(dock.style.transition).toBe("");
        // Nothing left of the keyboard's animation.
        now += 1000;
        keyboard(true, 300);
        now += 280;
        resizeTo(560);
        expect(dock.style.transition).toBe("");
        // A resize of no height does nothing.
        keyboard(false, 300);
        resizeTo(560);
        expect(dock.style.transition).toBe("");
    });

    it("glide puts each element back and lets it go", () => {
        const element = document.createElement("div");
        glide([element], -120, 200);
        expect(element.style.transform).toBe("");
        expect(element.style.transition).toBe(`transform 200ms ${KEYBOARD_EASING}`);
        element.dispatchEvent(new Event("transitionend"));
        expect(element.style.transition).toBe("");
    });
});
