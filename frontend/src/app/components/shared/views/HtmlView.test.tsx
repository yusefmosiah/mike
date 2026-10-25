import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { HtmlView } from "./HtmlView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));

afterEach(() => vi.resetAllMocks());

describe("HtmlView", () => {
    it("runs the page in a sandboxed frame without the app's origin", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response("<h1>Hi</h1><script>1</script>"));
        render(<HtmlView documentId="d1" versionId="v 2" filename="page.html" />);

        expect(screen.getByRole("status", { name: "Loading document" })).toBeInTheDocument();
        const frame = (await screen.findByTitle("page.html")) as HTMLIFrameElement;
        expect(frame.tagName).toBe("IFRAME");
        expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
        expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
        expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(frame.getAttribute("srcdoc")).toBe("<h1>Hi</h1><script>1</script>");
        // Never part of the app's own DOM.
        expect(document.querySelector("h1")).toBeNull();
        expect(screen.getByText(/Embedded videos may only play on the published page/)).toBeInTheDocument();
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file?version_id=v%202");
    });

    it("says so when the page cannot be loaded", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response("", { status: 404 }));
        render(<HtmlView documentId="d1" filename="page.html" rounded="top-right" />);
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file");
    });

    it("does not report a load that was abandoned", async () => {
        vi.mocked(authenticatedFetch).mockRejectedValueOnce(new Error("aborted"));
        const { unmount, container } = render(<HtmlView documentId="d1" filename="p.html" rounded={false} />);
        unmount();
        await Promise.resolve();
        expect(container.querySelector("iframe")).toBeNull();
    });
});
