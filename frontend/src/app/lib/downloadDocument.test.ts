import { afterEach, expect, it, vi } from "vitest";
import { downloadBlob, downloadDocumentFile } from "./downloadDocument";
import { getDocumentFile } from "./mikeApi";
vi.mock("./mikeApi", () => ({ getDocumentFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("uses the server filename, downloads bytes and releases the URL", async () => {
    vi.useFakeTimers();
    const blob = new Blob(["file"]);
    vi.mocked(getDocumentFile).mockResolvedValue({ blob, filename: "server.docx" });
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await downloadDocumentFile("doc", "v", "fallback.docx");
    vi.mocked(getDocumentFile).mockResolvedValue({ blob, filename: "" });
    await downloadDocumentFile("doc", null, "fallback.docx");
    await downloadDocumentFile("doc");
    expect(names).toEqual(["server.docx", "fallback.docx", "document"]);
    expect(getDocumentFile).toHaveBeenCalledWith("doc", "v");
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
});
it("cleans up even if clicking fails", async () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:failed");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("click"); });
    await expect(downloadBlob(new Blob(), "test")).rejects.toThrow("click");
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:failed");
});
it("hands the file to the iPhone app's share sheet instead of a link", async () => {
    const nativePromise = vi.fn().mockResolvedValue({ completed: true });
    (window as { Capacitor?: unknown }).Capacitor = { nativePromise, PluginHeaders: [{ name: "MikeFiles" }] };
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    try {
        await downloadBlob(new Blob(["docx"]), "brief.docx");
    } finally {
        delete (window as { Capacitor?: unknown }).Capacitor;
    }
    expect(nativePromise).toHaveBeenCalledWith("MikeFiles", "share", expect.objectContaining({ filename: "brief.docx" }));
    expect(click).not.toHaveBeenCalled();
});
