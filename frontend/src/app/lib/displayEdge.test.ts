import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayCornerRadius, updateDisplayEdge, watchDisplayEdge } from "./displayEdge";

let inset = 34;

beforeEach(() => {
    inset = 34;
    // jsdom lays nothing out: the probe reports whatever inset the test sets.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ height: inset }) as DOMRect,
    );
    vi.stubGlobal("Capacitor", { getPlatform: () => "ios" });
    vi.spyOn(window.screen, "width", "get").mockReturnValue(430);
    vi.spyOn(window.screen, "height", "get").mockReturnValue(932);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.displayEdge;
    document.documentElement.style.removeProperty("--display-corner-radius");
});

const root = () => document.documentElement;

describe("displayCornerRadius", () => {
    it("knows the iPhones by screen size in either orientation, with a default", () => {
        expect(displayCornerRadius(430, 932)).toBe(55);
        expect(displayCornerRadius(844, 390)).toBe(47.33);
        expect(displayCornerRadius(440, 956)).toBe(62);
        expect(displayCornerRadius(500, 1000)).toBe(55);
    });
});

describe("updateDisplayEdge", () => {
    it("marks the iPhone app running edge to edge, with its corner radius", () => {
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBe("");
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("55px");
        expect(document.body.children).toHaveLength(0);
    });

    it("leaves Safari and other browsers alone", () => {
        vi.stubGlobal("Capacitor", undefined);
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();

        vi.stubGlobal("Capacitor", { getPlatform: () => "android" });
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();

        vi.stubGlobal("Capacitor", {});
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();
    });

    it("unmarks an app build whose web view stops at the safe area", () => {
        updateDisplayEdge();
        inset = 0;
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("");
    });
});

describe("watchDisplayEdge", () => {
    it("updates on resize until stopped", () => {
        const stop = watchDisplayEdge();
        expect(root().dataset.displayEdge).toBe("");
        inset = 0;
        window.dispatchEvent(new Event("resize"));
        expect(root().dataset.displayEdge).toBeUndefined();
        stop();
        inset = 34;
        window.dispatchEvent(new Event("resize"));
        expect(root().dataset.displayEdge).toBeUndefined();
    });
});
