import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaView } from "./MediaView";

vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));

describe("MediaView", () => {
    it("plays a video from the document's file, at the version asked for", () => {
        const { container } = render(
            <MediaView documentId="d1" versionId="v2" filename="tour.mp4" kind="video" />,
        );
        const video = container.querySelector("video")!;
        expect(video).toHaveAttribute("src", "/api/single-documents/d1/file?version_id=v2");
        expect(video).toHaveAttribute("controls");
        expect(video).toHaveAttribute("aria-label", "tour.mp4");
    });

    it("names an audio file beside its player, and reloads after an edit", () => {
        const { container, rerender } = render(
            <MediaView documentId="d1" filename="Interview.m4a" kind="audio" />,
        );
        expect(screen.getByText("Interview.m4a")).toBeInTheDocument();
        expect(container.querySelector("audio")).toHaveAttribute("src", "/api/single-documents/d1/file");

        rerender(<MediaView documentId="d1" filename="Interview.m4a" kind="audio" refetchKey={3} />);
        expect(container.querySelector("audio")).toHaveAttribute("src", "/api/single-documents/d1/file?r=3");
    });

    it("says so when the file cannot be played", () => {
        const { container } = render(<MediaView documentId="d1" filename="tour.mov" kind="video" />);
        fireEvent.error(container.querySelector("video")!);
        expect(screen.getByRole("alert")).toHaveTextContent("The video could not be played.");
    });
});
