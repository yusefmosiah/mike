import { describe, expect, it } from "vitest";
import {
    ATTACHMENTS,
    IMAGE_TOO_LARGE_WARNING_MESSAGE,
    MAX_IMAGE_UPLOAD_BYTES,
    SUPPORTED_ATTACHMENT_ACCEPT,
    UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE,
    isImageFilename,
    SUPPORTED_DOCUMENT_ACCEPT,
    UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
    combineUploadWarnings,
    formatUnsupportedDocumentWarning,
    isSupportedDocumentFile,
    partitionSupportedDocumentFiles,
} from "./documentUploadValidation";

const file = (name: string) => new File(["content"], name);

describe("isSupportedDocumentFile", () => {
    it("accepts every extension advertised in SUPPORTED_DOCUMENT_ACCEPT", () => {
        // Keeps the <input accept=...> string and the validation set in sync:
        // if one gains an extension the other must too.
        const extensions = SUPPORTED_DOCUMENT_ACCEPT.split(",").map((s) =>
            s.replace(/^\./, ""),
        );
        expect(extensions.length).toBeGreaterThan(0);
        for (const ext of extensions) {
            expect(isSupportedDocumentFile(file(`contract.${ext}`))).toBe(true);
        }
    });

    it("is case-insensitive on the extension", () => {
        expect(isSupportedDocumentFile(file("SCAN.PDF"))).toBe(true);
        expect(isSupportedDocumentFile(file("Deed.DocX"))).toBe(true);
    });

    it("rejects unsupported types", () => {
        expect(isSupportedDocumentFile(file("notes.txt"))).toBe(false);
        expect(isSupportedDocumentFile(file("photo.png"))).toBe(false);
        expect(isSupportedDocumentFile(file("archive.zip"))).toBe(false);
    });

    it("uses only the last extension for multi-dot filenames", () => {
        expect(isSupportedDocumentFile(file("v1.2.final.pdf"))).toBe(true);
        expect(isSupportedDocumentFile(file("report.pdf.exe"))).toBe(false);
    });

    it("treats dotfiles like '.pdf' as having a pdf extension", () => {
        // ".pdf".split(".").pop() === "pdf" — documents current behavior.
        expect(isSupportedDocumentFile(file(".pdf"))).toBe(true);
    });

    it("treats an extensionless name equal to an extension as supported", () => {
        // "pdf".split(".").pop() === "pdf" — documents current behavior; a
        // file literally named "pdf" passes the extension check.
        expect(isSupportedDocumentFile(file("pdf"))).toBe(true);
        expect(isSupportedDocumentFile(file("README"))).toBe(false);
    });
});

describe("partitionSupportedDocumentFiles", () => {
    it("splits a mixed list preserving order within each bucket", () => {
        const a = file("a.pdf");
        const b = file("b.txt");
        const c = file("c.docx");
        const d = file("d.gif");
        const { supported, unsupported } = partitionSupportedDocumentFiles([
            a,
            b,
            c,
            d,
        ]);
        expect(supported).toEqual([a, c]);
        expect(unsupported).toEqual([b, d]);
    });

    it("returns two empty arrays for an empty input", () => {
        expect(partitionSupportedDocumentFiles([])).toEqual({
            supported: [],
            unsupported: [],
        });
    });
});

describe("formatUnsupportedDocumentWarning", () => {
    it("returns null when nothing was rejected", () => {
        expect(formatUnsupportedDocumentWarning([])).toBeNull();
    });

    it("returns the shared warning message when files were rejected", () => {
        expect(formatUnsupportedDocumentWarning([file("x.txt")])).toBe(
            UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
        );
    });
});

describe("combineUploadWarnings", () => {
    it("returns null when there is nothing to warn about", () => {
        expect(combineUploadWarnings(null, undefined)).toBeNull();
    });

    it("treats a blank string as nothing to warn about", () => {
        expect(combineUploadWarnings("   ", null)).toBeNull();
    });

    it("passes a single warning through unchanged", () => {
        expect(combineUploadWarnings(null, "Only warning.")).toBe(
            "Only warning.",
        );
    });

    it("joins unsupported-type and failed-upload warnings into one strip", () => {
        expect(combineUploadWarnings("First.", null, "Second.")).toBe(
            "First. Second.",
        );
    });

    it("does not repeat an identical message twice", () => {
        expect(combineUploadWarnings("Same.", "Same.")).toBe("Same.");
    });
});

describe("attachments: documents, images and text", () => {
    const sized = (name: string, bytes: number) =>
        Object.defineProperty(new File(["x"], name), "size", { value: bytes });

    it("accepts every image extension advertised, and every document one", () => {
        const extensions = SUPPORTED_ATTACHMENT_ACCEPT.split(",").map((s) => s.replace(/^\./, ""));
        for (const ext of extensions) {
            expect(isSupportedDocumentFile(file(`photo.${ext}`), ATTACHMENTS)).toBe(true);
        }
        expect(isImageFilename("Site.JPG")).toBe(true);
        expect(isImageFilename("logo.svg")).toBe(false);
        expect(isImageFilename("README")).toBe(false);
    });

    it("keeps images out where only documents belong", () => {
        expect(isSupportedDocumentFile(file("photo.png"))).toBe(false);
        expect(formatUnsupportedDocumentWarning([file("photo.png")])).toBe(UNSUPPORTED_DOCUMENT_WARNING_MESSAGE);
    });

    it("accepts plain text only where attachments are", () => {
        for (const name of ["notes.txt", "README.md", "ledger.CSV"]) {
            expect(isSupportedDocumentFile(file(name), ATTACHMENTS)).toBe(true);
            expect(isSupportedDocumentFile(file(name))).toBe(false);
        }
        expect(isSupportedDocumentFile(file("notes.txt"), { text: true })).toBe(true);
        expect(isSupportedDocumentFile(file("photo.png"), { text: true })).toBe(false);
        expect(formatUnsupportedDocumentWarning([file("run.sh")], { text: true })).toBe(
            UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE,
        );
    });

    it("refuses an SVG and an image over 20 MB, saying which", () => {
        const big = sized("scan.jpg", MAX_IMAGE_UPLOAD_BYTES + 1);
        const { supported, unsupported } = partitionSupportedDocumentFiles(
            [file("a.png"), file("logo.svg"), big],
            ATTACHMENTS,
        );
        expect(supported.map((f) => f.name)).toEqual(["a.png"]);
        expect(unsupported.map((f) => f.name)).toEqual(["logo.svg", "scan.jpg"]);
        expect(formatUnsupportedDocumentWarning([big], ATTACHMENTS)).toBe(IMAGE_TOO_LARGE_WARNING_MESSAGE);
        expect(formatUnsupportedDocumentWarning([file("logo.svg")], ATTACHMENTS)).toBe(
            UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE,
        );
        expect(formatUnsupportedDocumentWarning(unsupported, ATTACHMENTS)).toBe(
            `${UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE} ${IMAGE_TOO_LARGE_WARNING_MESSAGE}`,
        );
        expect(formatUnsupportedDocumentWarning([], ATTACHMENTS)).toBeNull();
        expect(isSupportedDocumentFile(file("noextension."), ATTACHMENTS)).toBe(false);
    });
});
