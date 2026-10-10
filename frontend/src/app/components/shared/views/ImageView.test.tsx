import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { ImageView } from "./ImageView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:site");
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.clearAllMocks());

describe("ImageView", () => {
    it("shows the stored image at the version asked for, named by its filename", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Blob(["png"]), { status: 200 }));
        const { unmount } = render(<ImageView documentId="d1" versionId="v2" filename="site.jpg" />);

        expect(screen.getByRole("status", { name: "Loading image" })).toBeInTheDocument();
        expect(await screen.findByRole("img", { name: "site.jpg" })).toHaveAttribute("src", "blob:site");
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file?version_id=v2");

        unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:site");
    });

    it("says so when the image cannot be loaded", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValue(new Response("", { status: 404 }));
        render(<ImageView documentId="d1" filename="site.jpg" />);

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file");
    });
});
