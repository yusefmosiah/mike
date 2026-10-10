import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelsVision } from "@/app/lib/mikeApi";

vi.mock("@/app/lib/mikeApi", () => ({ getModelsVision: vi.fn() }));

import { resetModelVisionForTests, useModelVision } from "./useModelVision";

afterEach(() => {
    vi.clearAllMocks();
    resetModelVisionForTests();
});

describe("useModelVision", () => {
    it("asks once for the models it has not heard about, and remembers", async () => {
        vi.mocked(getModelsVision).mockResolvedValue({ "claude-opus-5": true, "opencode-go/glm-5.3": false });
        const { result } = renderHook(() => useModelVision(["claude-opus-5", "opencode-go/glm-5.3", "claude-opus-5"]));

        expect(result.current).toEqual({});
        await waitFor(() => expect(result.current).toEqual({ "claude-opus-5": true, "opencode-go/glm-5.3": false }));
        expect(getModelsVision).toHaveBeenCalledWith(["claude-opus-5", "opencode-go/glm-5.3"]);

        const again = renderHook(() => useModelVision(["opencode-go/glm-5.3"]));
        expect(again.result.current).toEqual({ "opencode-go/glm-5.3": false });
        expect(getModelsVision).toHaveBeenCalledTimes(1);
    });

    it("shares a lookup already in flight instead of asking twice", async () => {
        let answer!: (vision: Record<string, boolean>) => void;
        vi.mocked(getModelsVision).mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const first = renderHook(() => useModelVision(["kimi"]));
        const second = renderHook(() => useModelVision(["kimi"]));
        answer({ kimi: true });

        await waitFor(() => expect(second.result.current).toEqual({ kimi: true }));
        expect(first.result.current).toEqual({ kimi: true });
        expect(getModelsVision).toHaveBeenCalledTimes(1);
    });

    it("leaves a model unknown when the lookup fails, and asks again later", async () => {
        vi.mocked(getModelsVision).mockRejectedValueOnce(new Error("offline"));
        const { result, unmount } = renderHook(() => useModelVision(["gemma"]));
        await waitFor(() => expect(getModelsVision).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(result.current).toEqual({}));
        unmount();

        vi.mocked(getModelsVision).mockResolvedValueOnce({ gemma: true });
        const retry = renderHook(() => useModelVision(["gemma"]));
        await waitFor(() => expect(retry.result.current).toEqual({ gemma: true }));
    });

    it("asks nothing for an empty list", () => {
        const { result } = renderHook(() => useModelVision([]));
        expect(result.current).toEqual({});
        expect(getModelsVision).not.toHaveBeenCalled();
    });
});
