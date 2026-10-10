import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    autoCheckDocumentCitations,
    getDocumentCitationChecks,
    type DocumentCitationChecks,
} from "@/app/lib/mikeApi";
import { useDocumentCitationChecks } from "./useDocumentCitationChecks";

vi.mock("@/app/lib/mikeApi", () => ({
    getDocumentCitationChecks: vi.fn(),
    autoCheckDocumentCitations: vi.fn(),
}));

const task = (status: "queued" | "running" | "completed") => ({
    id: "t1",
    document_version_id: "v1",
    status,
    created_at: "2026-10-10T00:00:00Z",
    finished_at: null,
});
const response = (overrides: Partial<DocumentCitationChecks>): DocumentCitationChecks => ({
    task: null,
    checks: [],
    current_version_id: "v1",
    ...overrides,
});

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it("follows a scheduled check until it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getDocumentCitationChecks)
        .mockResolvedValueOnce(response({ auto_pending: true }))
        .mockResolvedValueOnce(response({ task: task("running") }))
        .mockResolvedValue(response({ task: task("completed") }));
    const { result } = renderHook(() => useDocumentCitationChecks("doc"));
    await waitFor(() => expect(result.current.status).toBe("checking"));
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(getDocumentCitationChecks).toHaveBeenCalledTimes(3);
    expect(autoCheckDocumentCitations).not.toHaveBeenCalled();
});

it("asks for a check when opened, and stays quiet with nothing to show or on failure", async () => {
    vi.mocked(autoCheckDocumentCitations).mockRejectedValue(new Error("no model"));
    vi.mocked(getDocumentCitationChecks).mockResolvedValueOnce(response({}));
    const { result, rerender } = renderHook(({ id }) => useDocumentCitationChecks(id, { requestAuto: true }), {
        initialProps: { id: "doc" },
    });
    await waitFor(() => expect(getDocumentCitationChecks).toHaveBeenCalledTimes(1));
    expect(autoCheckDocumentCitations).toHaveBeenCalledWith("doc");
    expect(result.current.status).toBe("idle");
    vi.mocked(getDocumentCitationChecks).mockRejectedValueOnce(new Error("network"));
    rerender({ id: "other" });
    await waitFor(() => expect(getDocumentCitationChecks).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("idle");
});
