import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBrowserSupported, openInNativeBrowser } from "./nativeBrowser";

type G = { Capacitor?: unknown };

function installBridge(nativePromise = vi.fn().mockResolvedValue(undefined), methods = ["open", "close"]) {
    (globalThis as G).Capacitor = {
        PluginHeaders: [{ name: "Browser", methods: methods.map((name) => ({ name })) }],
        nativePromise,
    };
    return nativePromise;
}

afterEach(() => {
    delete (globalThis as G).Capacitor;
});

describe("nativeBrowser", () => {
    it("is unsupported in a browser", async () => {
        expect(nativeBrowserSupported()).toBe(false);
        expect(await openInNativeBrowser("https://example.com")).toBe(false);
    });

    it("is unsupported when the shell lacks the Browser plugin", async () => {
        (globalThis as G).Capacitor = { PluginHeaders: [], nativePromise: vi.fn() };
        expect(nativeBrowserSupported()).toBe(false);
        installBridge(vi.fn(), ["close"]);
        expect(nativeBrowserSupported()).toBe(false);
    });

    it("opens an http(s) page in the Safari view", async () => {
        const call = installBridge();
        expect(nativeBrowserSupported()).toBe(true);
        expect(await openInNativeBrowser("https://example.com/a#:~:text=hi")).toBe(true);
        expect(call).toHaveBeenCalledWith("Browser", "open", { url: "https://example.com/a#:~:text=hi" });
    });

    it("never opens other schemes or junk", async () => {
        const call = installBridge();
        expect(await openInNativeBrowser("javascript:alert(1)")).toBe(false);
        expect(await openInNativeBrowser("mike://x")).toBe(false);
        expect(await openInNativeBrowser("not a url")).toBe(false);
        expect(call).not.toHaveBeenCalled();
    });

    it("reports false when the view fails to open", async () => {
        installBridge(vi.fn().mockRejectedValue(new Error("Unable to display URL")));
        expect(await openInNativeBrowser("https://example.com")).toBe(false);
    });
});
