import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentCopyButton } from "./DocumentCopyButton";

const fetchDocumentText = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    fetchDocumentText,
}));
const writeText = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

beforeEach(() => {
    vi.resetAllMocks();
    fetchDocumentText.mockResolvedValue({ text: "document body", chars: 13, format: "text" });
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function clickCopy() {
    fireEvent.click(screen.getByRole("button", { name: "Copy document text" }));
}

describe("DocumentCopyButton", () => {
    it("copies the server-flattened text to the clipboard and flashes a check", async () => {
        render(<DocumentCopyButton documentId="d1" versionId={null} />);
        clickCopy();
        await waitFor(() => expect(writeText).toHaveBeenCalledWith("document body"));
        expect(fetchDocumentText).toHaveBeenCalledWith("d1", null);
        expect(await screen.findByRole("button", { name: "Copy document text" })).toBeEnabled();
    });

    it("prefers the live editor's rich copy and skips the clipboard write", async () => {
        const onCopy = vi.fn().mockResolvedValue(undefined);
        render(<DocumentCopyButton documentId="d1" versionId="v2" onCopy={onCopy} />);
        clickCopy();
        await waitFor(() => expect(onCopy).toHaveBeenCalledOnce());
        // The fetch still runs first to size the confirmation gate.
        expect(fetchDocumentText).toHaveBeenCalledWith("d1", "v2");
        expect(writeText).not.toHaveBeenCalled();
    });

    it("falls back to plain text when the engine copy is refused", async () => {
        const onCopy = vi.fn().mockRejectedValue(new Error("engine refused"));
        render(<DocumentCopyButton documentId="d1" versionId={null} onCopy={onCopy} />);
        clickCopy();
        await waitFor(() => expect(writeText).toHaveBeenCalledWith("document body"));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("asks for confirmation before copying a very large document", async () => {
        fetchDocumentText.mockResolvedValue({ text: "huge", chars: 200_000, format: "text" });
        render(<DocumentCopyButton documentId="d1" versionId={null} />);
        clickCopy();
        expect(await screen.findByRole("dialog")).toHaveTextContent(/very large/);
        expect(writeText).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith("huge"));
    });

    it("does not copy when the large-document confirmation is cancelled", async () => {
        fetchDocumentText.mockResolvedValue({ text: "huge", chars: 200_000, format: "text" });
        render(<DocumentCopyButton documentId="d1" versionId={null} />);
        clickCopy();
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(writeText).not.toHaveBeenCalled();
    });

    it("shows a friendly error when the text fetch fails", async () => {
        fetchDocumentText.mockRejectedValue(new Error("socket closed"));
        render(<DocumentCopyButton documentId="d1" versionId={null} />);
        clickCopy();
        expect(await screen.findByRole("alert")).toHaveTextContent(/could not be copied/);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("ignores clicks while the document is reloading", () => {
        render(<DocumentCopyButton documentId="d1" versionId={null} isReloading />);
        clickCopy();
        expect(fetchDocumentText).not.toHaveBeenCalled();
    });
});
