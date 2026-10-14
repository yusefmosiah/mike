import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeFileSaveSupported, saveFileNatively } from "./nativeFiles";

type Win = { Capacitor?: unknown };

afterEach(() => {
    delete (window as Win).Capacitor;
});

describe("saving a file in the iPhone app", () => {
    it("does nothing in a browser, or in an app build without the plugin", async () => {
        expect(nativeFileSaveSupported()).toBe(false);
        expect(await saveFileNatively(new Blob(["x"]), "a.txt")).toBe(false);
        (window as Win).Capacitor = { nativePromise: vi.fn(), PluginHeaders: [{ name: "MikeSpeech" }] };
        expect(nativeFileSaveSupported()).toBe(false);
    });

    it("sends the bytes, name and type to the share sheet", async () => {
        const nativePromise = vi.fn().mockResolvedValue({ completed: true });
        (window as Win).Capacitor = { nativePromise, PluginHeaders: [{ name: "MikeFiles" }] };
        expect(nativeFileSaveSupported()).toBe(true);
        const ok = await saveFileNatively(new Blob(["hello"], { type: "text/plain" }), "notes.txt");
        expect(ok).toBe(true);
        expect(nativePromise).toHaveBeenCalledWith("MikeFiles", "share", {
            data: btoa("hello"),
            filename: "notes.txt",
            mimeType: "text/plain",
        });
        await saveFileNatively(new Blob(["x"]), "raw");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeFiles", "share", { data: btoa("x"), filename: "raw" });
    });

    it("passes a failure on to the caller", async () => {
        (window as Win).Capacitor = {
            nativePromise: vi.fn().mockRejectedValue(new Error("The file could not be saved.")),
            PluginHeaders: [{ name: "MikeFiles" }],
        };
        await expect(saveFileNatively(new Blob(["x"]), "a")).rejects.toThrow("could not be saved");
    });
});
