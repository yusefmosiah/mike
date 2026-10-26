import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileTypeIcon, fileTypeKind } from "./FileTypeIcon";

describe("fileTypeKind", () => {
    it("maps bare file_type values to a kind", () => {
        expect(fileTypeKind("pdf")).toBe("pdf");
        expect(fileTypeKind("docx")).toBe("word");
        expect(fileTypeKind("doc")).toBe("word");
        expect(fileTypeKind("xlsx")).toBe("excel");
        expect(fileTypeKind("xlsm")).toBe("excel");
        expect(fileTypeKind("xls")).toBe("excel");
        expect(fileTypeKind("pptx")).toBe("ppt");
        expect(fileTypeKind("ppt")).toBe("ppt");
    });

    it("maps filenames by their extension", () => {
        expect(fileTypeKind("report.pdf")).toBe("pdf");
        expect(fileTypeKind("Quarterly Deck.PPTX")).toBe("ppt");
        expect(fileTypeKind("model.final.xlsx")).toBe("excel");
    });

    it("names images by file type or filename", () => {
        expect(fileTypeKind("jpg")).toBe("image");
        expect(fileTypeKind("Site Photo.PNG")).toBe("image");
        expect(fileTypeKind("logo.svg")).toBe("other");
    });

    it("is case-insensitive and trims whitespace", () => {
        expect(fileTypeKind("  PDF ")).toBe("pdf");
        expect(fileTypeKind("DOCX")).toBe("word");
    });

    it("knows plain text", () => {
        expect(["txt", "md", "CSV"].map(fileTypeKind)).toEqual(["text", "text", "text"]);
        expect(fileTypeKind("page.html")).toBe("html");
    });

    it("knows audio and video", () => {
        expect(["mp3", "talk.M4A", "wav", "ogg"].map(fileTypeKind)).toEqual(["audio", "audio", "audio", "audio"]);
        expect(["mp4", "tour.mov", "webm"].map(fileTypeKind)).toEqual(["video", "video", "video"]);
    });

    it("falls back to other for unknown, empty, or nullish input", () => {
        expect(fileTypeKind("sh")).toBe("other");
        expect(fileTypeKind("")).toBe("other");
        expect(fileTypeKind(null)).toBe("other");
        expect(fileTypeKind(undefined)).toBe("other");
    });
});

describe("FileTypeIcon", () => {
    const svgOf = (container: HTMLElement) => container.querySelector("svg");
    const imgOf = (container: HTMLElement) => container.querySelector("img");

    it("renders a decorative image icon for an image", () => {
        const { container } = render(<FileTypeIcon fileType="webp" />);
        expect(imgOf(container)).toBeNull();
        expect(svgOf(container)).toHaveAttribute("aria-hidden", "true");
    });

    it("renders a decorative code icon for an HTML page", () => {
        const { container } = render(<FileTypeIcon fileType="page.html" />);
        expect(imgOf(container)).toBeNull();
        expect(svgOf(container)).toHaveAttribute("aria-hidden", "true");
    });

    it("renders decorative icons for audio and video", () => {
        for (const fileType of ["talk.mp3", "tour.mp4"]) {
            const { container } = render(<FileTypeIcon fileType={fileType} />);
            expect(imgOf(container)).toBeNull();
            expect(svgOf(container)).toHaveAttribute("aria-hidden", "true");
        }
    });

    it("renders the PDF icon image", () => {
        const { container } = render(<FileTypeIcon fileType="pdf" />);
        expect(imgOf(container)).toHaveAttribute(
            "src",
            expect.stringContaining("/icons/file-types/pdf.svg"),
        );
    });

    it("renders the Word icon image", () => {
        const { container } = render(<FileTypeIcon fileType="deck.docx" />);
        expect(imgOf(container)).toHaveAttribute(
            "src",
            expect.stringContaining("/icons/file-types/word.svg"),
        );
    });

    it("renders the Excel icon image", () => {
        const { container } = render(<FileTypeIcon fileType="xlsx" />);
        expect(imgOf(container)).toHaveAttribute(
            "src",
            expect.stringContaining("/icons/file-types/excel.svg"),
        );
    });

    it("renders a grey icon for unknown types", () => {
        const { container } = render(<FileTypeIcon fileType={null} />);
        expect(svgOf(container)).toHaveClass("text-gray-500");
    });

    it("renders a muted grayscale image for a known kind", () => {
        const { container } = render(<FileTypeIcon fileType="pdf" muted />);
        const img = imgOf(container);
        expect(img).toHaveClass("grayscale");
        expect(img).toHaveClass("opacity-35");
    });

    it("renders a muted grey placeholder for unknown types", () => {
        const { container } = render(<FileTypeIcon fileType={null} muted />);
        const svg = svgOf(container);
        expect(svg).toHaveClass("text-gray-300");
    });

    it("always applies shrink-0 and merges a custom className", () => {
        const { container } = render(
            <FileTypeIcon fileType="pdf" className="h-6 w-6" />,
        );
        const img = imgOf(container);
        expect(img).toHaveClass("shrink-0");
        expect(img).toHaveClass("h-6");
        expect(img).toHaveClass("w-6");
    });
});
