import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePublishAction } from "./usePublishAction";

const api = vi.hoisted(() => ({ getPublishingConfig: vi.fn(), listPublications: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));

beforeEach(() => {
    vi.clearAllMocks();
    api.listPublications.mockResolvedValue([]);
});

const doc = { documentId: "d1", versionId: "v1", filename: "plan.html" };

describe("usePublishAction", () => {
    it("offers Publish for publishable files when publishing is on, and opens the modal", async () => {
        api.getPublishingConfig.mockResolvedValue({ enabled: true, audiences: ["public"] });
        const { result } = renderHook(() => usePublishAction());
        expect(result.current.publishAction(doc)).toBeUndefined();
        await waitFor(() => expect(result.current.publishAction(doc)).toBeTypeOf("function"));
        expect(result.current.publishAction({ ...doc, filename: "sheet.xlsx", fileType: "xlsx" })).toBeUndefined();

        render(<>{result.current.publishModal}</>);
        expect(screen.queryByRole("dialog")).toBeNull();
        act(() => result.current.publishAction(doc)!());
        render(<>{result.current.publishModal}</>);
        expect(await screen.findByRole("dialog", { name: "plan.html" })).toBeInTheDocument();
        expect(api.listPublications).toHaveBeenCalledWith("d1");
    });

    it("closes the modal", async () => {
        api.getPublishingConfig.mockResolvedValue({ enabled: true, audiences: ["public"] });
        const { result } = renderHook(() => usePublishAction());
        await waitFor(() => expect(result.current.publishAction(doc)).toBeTypeOf("function"));
        act(() => result.current.publishAction(doc)!());
        expect(result.current.publishModal).not.toBeNull();
        const view = render(<>{result.current.publishModal}</>);
        (await screen.findByRole("button", { name: "Done" })).click();
        await waitFor(() => expect(result.current.publishModal).toBeNull());
        view.unmount();
    });

    it("offers nothing when publishing is off, has no audiences, or the config cannot load", async () => {
        api.getPublishingConfig.mockResolvedValueOnce({ enabled: false, audiences: [], reason: "off" });
        const off = renderHook(() => usePublishAction());
        await waitFor(() => expect(api.getPublishingConfig).toHaveBeenCalled());
        expect(off.result.current.publishAction(doc)).toBeUndefined();

        api.getPublishingConfig.mockResolvedValueOnce({ enabled: true, audiences: [] });
        const none = renderHook(() => usePublishAction());
        await waitFor(() => expect(api.getPublishingConfig).toHaveBeenCalledTimes(2));
        expect(none.result.current.publishAction(doc)).toBeUndefined();

        api.getPublishingConfig.mockRejectedValueOnce(new Error("x"));
        const failed = renderHook(() => usePublishAction());
        await waitFor(() => expect(api.getPublishingConfig).toHaveBeenCalledTimes(3));
        expect(failed.result.current.publishAction(doc)).toBeUndefined();
    });

    it("ignores a config that arrives after unmount", async () => {
        let resolve!: (v: unknown) => void;
        api.getPublishingConfig.mockReturnValue(new Promise((r) => (resolve = r)));
        const { unmount } = renderHook(() => usePublishAction());
        unmount();
        resolve({ enabled: true, audiences: ["public"] });
        await Promise.resolve();
    });
});
