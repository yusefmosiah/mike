import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerControlsDrop, displayCornerRadius, updateDisplayEdge, watchDisplayEdge } from "./displayEdge";

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
    document.documentElement.style.removeProperty("--chat-controls-drop");
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

describe("composerControlsDrop", () => {
    it("drops the controls until the send button is 12px from the composer's curved corner", () => {
        // A 62pt display corner: the composer's corner is 56. The button's
        // centre comes 28 from the curve's centre, 17 across and 22 down, so
        // its bottom sits about 18 above the composer's instead of 23.
        expect(composerControlsDrop(62)).toBe(5);
        expect(composerControlsDrop(55)).toBe(8.5);
        expect(composerControlsDrop(53.33)).toBe(9);
    });

    it("stops 12px above the bottom where the corner is too small to matter", () => {
        expect(composerControlsDrop(47.33)).toBe(11);
        expect(composerControlsDrop(39)).toBe(11);
    });

    it("never raises the controls", () => {
        expect(composerControlsDrop(200)).toBe(0);
    });
});

describe("updateDisplayEdge", () => {
    it("marks the iPhone app running edge to edge, with its corner radius", () => {
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBe("");
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("55px");
        expect(root().style.getPropertyValue("--chat-controls-drop")).toBe("8.5px");
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

    it("leaves an app build whose web view stops at the safe area unmarked", () => {
        inset = 0;
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("");
        expect(root().style.getPropertyValue("--chat-controls-drop")).toBe("");
    });

    it("stays marked once marked, whatever the inset reads later", () => {
        updateDisplayEdge();
        inset = 0;
        updateDisplayEdge();
        expect(root().dataset.displayEdge).toBe("");
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("55px");
    });
});

describe("watchDisplayEdge", () => {
    let observed: { callback: ResizeObserverCallback; target?: Element; disconnected: boolean }[] = [];

    beforeEach(() => {
        observed = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                entry: (typeof observed)[number];
                constructor(callback: ResizeObserverCallback) {
                    this.entry = { callback, disconnected: false };
                    observed.push(this.entry);
                }
                observe(target: Element) {
                    this.entry.target = target;
                }
                disconnect() {
                    this.entry.disconnected = true;
                }
            },
        );
    });

    const insetChanges = () => observed[0].callback([], {} as ResizeObserver);

    it("marks the page when the inset arrives after it first ran, with no resize event", () => {
        inset = 0;
        const stop = watchDisplayEdge();
        expect(root().dataset.displayEdge).toBeUndefined();
        expect(observed[0].target?.getAttribute("aria-hidden")).toBe("true");

        inset = 34;
        insetChanges();
        expect(root().dataset.displayEdge).toBe("");
        stop();
    });

    it("follows rotation on resize, and stops watching when asked", () => {
        const stop = watchDisplayEdge();
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("55px");
        vi.spyOn(window.screen, "width", "get").mockReturnValue(390);
        vi.spyOn(window.screen, "height", "get").mockReturnValue(844);
        window.dispatchEvent(new Event("resize"));
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("47.33px");

        stop();
        expect(observed[0].disconnected).toBe(true);
        expect(observed[0].target?.isConnected).toBe(false);
        vi.spyOn(window.screen, "width", "get").mockReturnValue(430);
        vi.spyOn(window.screen, "height", "get").mockReturnValue(932);
        window.dispatchEvent(new Event("resize"));
        expect(root().style.getPropertyValue("--display-corner-radius")).toBe("47.33px");
    });

    it("still watches resizes where ResizeObserver is missing", () => {
        vi.stubGlobal("ResizeObserver", undefined);
        inset = 0;
        const stop = watchDisplayEdge();
        inset = 34;
        window.dispatchEvent(new Event("resize"));
        expect(root().dataset.displayEdge).toBe("");
        stop();
    });
});
