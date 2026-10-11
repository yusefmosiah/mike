import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { TextView } from "./TextView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));

afterEach(() => vi.clearAllMocks());

describe("TextView", () => {
    it("shows the text as written at the version asked for, named by its filename", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValue(new Response("# Notes\n\n- one", { status: 200 }));
        render(<TextView documentId="d1" versionId="v2" filename="notes.md" />);

        expect(screen.getByRole("status", { name: "Loading document" })).toBeInTheDocument();
        const text = await screen.findByLabelText("notes.md");
        expect(text.tagName).toBe("PRE");
        expect(text.textContent).toBe("# Notes\n\n- one");
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file?version_id=v2");
    });

    it("says so when the text cannot be loaded", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValue(new Response("", { status: 404 }));
        render(<TextView documentId="d1" filename="notes.md" rounded="top-right" />);

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file");
    });

    it("loads again for a new version", async () => {
        vi.mocked(authenticatedFetch)
            .mockResolvedValueOnce(new Response("first", { status: 200 }))
            .mockResolvedValueOnce(new Response("second", { status: 200 }));
        const { rerender } = render(<TextView documentId="d1" versionId="v1" filename="a.txt" rounded={false} />);
        expect((await screen.findByLabelText("a.txt")).textContent).toBe("first");
        rerender(<TextView documentId="d1" versionId="v2" filename="a.txt" rounded={false} />);
        await waitFor(() => expect(screen.getByLabelText("a.txt").textContent).toBe("second"));
    });
});
