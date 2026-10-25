import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDarkMode, followDarkMode } from "./theme";

afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
});

describe("applyDarkMode", () => {
    it("enables dark colors on the document root", () => {
        applyDarkMode(true);
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("returns the document root to light mode", () => {
        document.documentElement.classList.add("dark");
        applyDarkMode(false);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe("light");
    });

    it("does nothing when rendered without a document", () => {
        vi.stubGlobal("document", undefined);
        expect(() => applyDarkMode(true)).not.toThrow();
    });
});

describe("followDarkMode", () => {
    function stubSystem(dark: boolean) {
        const listeners = new Set<() => void>();
        const query = {
            matches: dark,
            addEventListener: (_: string, fn: () => void) => listeners.add(fn),
            removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        };
        vi.stubGlobal("matchMedia", () => query);
        return {
            set(next: boolean) {
                query.matches = next;
                listeners.forEach((fn) => fn());
            },
            listeners,
        };
    }

    it("applies an explicit choice whatever the device says", () => {
        stubSystem(true);
        followDarkMode(false);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("follows the device, including when it switches", () => {
        const system = stubSystem(true);
        const stop = followDarkMode(null);
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        system.set(false);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
        stop();
        expect(system.listeners.size).toBe(0);
        system.set(true);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
});
