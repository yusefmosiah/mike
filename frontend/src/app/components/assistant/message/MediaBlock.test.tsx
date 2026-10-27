import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantEvent } from "@/app/components/shared/types";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { MediaBlock } from "./MediaBlock";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));

type MediaEvent = Extract<AssistantEvent, { type: "media" }>;

const image = (overrides: Partial<MediaEvent> = {}): MediaEvent => ({
    type: "media",
    document_id: "doc-1",
    version_id: "v1",
    version_number: 2,
    filename: "chart.png",
    kind: "image",
    caption: "Monthly spend",
    ...overrides,
});

const video = (overrides: Partial<MediaEvent> = {}): MediaEvent => ({
    type: "media",
    document_id: "doc-2",
    version_id: null,
    version_number: 1,
    filename: "demo.mp4",
    kind: "video",
    ...overrides,
});

const audio = (overrides: Partial<MediaEvent> = {}): MediaEvent => ({
    type: "media",
    document_id: "doc-3",
    version_id: null,
    version_number: 1,
    filename: "note.mp3",
    kind: "audio",
    ...overrides,
});

function blobOk() {
    // A fresh Response per call: the first tile consumes the body.
    vi.mocked(authenticatedFetch).mockImplementation(() =>
        Promise.resolve(new Response(new Blob(["bytes"]), { status: 200 })),
    );
}

describe("MediaBlock", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        URL.createObjectURL = vi.fn(() => "blob:media");
        URL.revokeObjectURL = vi.fn();
    });

    it("renders nothing for no events", () => {
        const { container } = render(<MediaBlock events={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows a single image with its caption and requests the file with the version", async () => {
        blobOk();
        render(<MediaBlock events={[image()]} onOpenDocument={vi.fn()} />);

        // Captioned images are presentational; the labeled button is the control.
        await screen.findByRole("button", {
            name: "Open chart.png in the document viewer",
        });
        const img = document.querySelector("img") as HTMLImageElement;
        expect(img.src).toContain("blob:media");
        expect(img).toHaveAttribute("alt", "");
        expect(img).toHaveAttribute("loading", "lazy");
        expect(authenticatedFetch).toHaveBeenCalledWith(
            "/api/single-documents/doc-1/file?version_id=v1",
            expect.objectContaining({ credentials: "include" }),
        );
    });

    it("uses the filename as alt text when there is no caption", async () => {
        blobOk();
        render(
            <MediaBlock
                events={[image({ caption: undefined })]}
                onOpenDocument={vi.fn()}
            />,
        );
        expect(await screen.findByRole("img")).toHaveAttribute(
            "alt",
            "chart.png",
        );
        expect(
            screen.queryByRole("button", { name: /chart\.png/ }),
        ).toHaveAccessibleName("Open chart.png in the document viewer");
    });

    it("grids adjacent images in two columns", async () => {
        blobOk();
        render(
            <MediaBlock
                events={[
                    image({ document_id: "d1", filename: "a.png" }),
                    image({ document_id: "d2", filename: "b.png" }),
                    image({ document_id: "d3", filename: "c.png" }),
                ]}
                onOpenDocument={vi.fn()}
            />,
        );
        await waitFor(() =>
            expect(
                screen.queryAllByRole("button", {
                    name: /in the document viewer/,
                }),
            ).toHaveLength(3),
        );
        expect(document.querySelectorAll("img")).toHaveLength(3);
        expect(
            screen
                .getByRole("button", { name: /a\.png/ })
                .closest("div.grid"),
        ).toHaveClass("md:grid-cols-2");
    });

    it("opens the exact document and version on a tile tap", async () => {
        blobOk();
        const onOpenDocument = vi.fn();
        render(
            <MediaBlock events={[image()]} onOpenDocument={onOpenDocument} />,
        );
        fireEvent.click(await screen.findByRole("button"));
        expect(onOpenDocument).toHaveBeenCalledWith({
            documentId: "doc-1",
            filename: "chart.png",
            versionId: "v1",
            versionNumber: 2,
        });
    });

    it("shows a failed image as an alert placeholder, not a broken icon", async () => {
        vi.mocked(authenticatedFetch).mockResolvedValue(
            new Response("no", { status: 403 }),
        );
        render(<MediaBlock events={[image()]} />);
        expect(
            await screen.findByRole("alert"),
        ).toHaveTextContent("chart.png could not be loaded");
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("renders video with the native player and a separate open action", () => {
        const onOpenDocument = vi.fn();
        render(<MediaBlock events={[video()]} onOpenDocument={onOpenDocument} />);
        const player = document.querySelector("video")!;
        expect(player).toHaveAttribute("controls");
        expect(player).toHaveAttribute("playsinline");
        expect(player.getAttribute("src")).toContain(
            "/api/single-documents/doc-2/file",
        );
        expect(player.closest("button")).toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "Open demo.mp4 in viewer" }),
        );
        expect(onOpenDocument).toHaveBeenCalledWith({
            documentId: "doc-2",
            filename: "demo.mp4",
            versionId: null,
            versionNumber: 1,
        });
    });

    it("renders audio with the native player and its filename", () => {
        render(<MediaBlock events={[audio()]} />);
        const player = document.querySelector("audio")!;
        expect(player).toHaveAttribute("controls");
        expect(player.getAttribute("src")).toContain(
            "/api/single-documents/doc-3/file",
        );
        expect(screen.getByText("note.mp3")).toBeInTheDocument();
    });

    it("shows a video failure as an alert placeholder", async () => {
        render(<MediaBlock events={[video()]} />);
        const player = document.querySelector("video")!;
        fireEvent.error(player);
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "The video could not be played",
            ),
        );
    });

    it("keeps runs: image grid, then a full-width player", async () => {
        blobOk();
        render(
            <MediaBlock events={[image(), image({ document_id: "d2", filename: "b.png" }), video()]} onOpenDocument={vi.fn()} />,
        );
        await waitFor(() =>
            expect(
                screen.queryAllByRole("button", {
                    name: /in the document viewer/,
                }),
            ).toHaveLength(2),
        );
        expect(document.querySelectorAll("img")).toHaveLength(2);
        expect(document.querySelector("video")).toBeInTheDocument();
    });
});
