import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentTitleRow } from "./DocumentTitleRow";
import type { PanelDocument } from "./types";
import type { DocxSaveState } from "./views/DocxRenderer.types";

const document = {
    document_id: "doc-1",
    title: "Agreement.docx",
    type: "docx",
    metadata: [],
    quotes: [],
} as unknown as PanelDocument;

function state(overrides: Partial<DocxSaveState>): DocxSaveState {
    return { ready: true, dirty: false, status: "idle", error: null, ...overrides };
}

function view(saveState: DocxSaveState) {
    return (
        <DocumentTitleRow
            document={document}
            isReloading={false}
            compactActions
            saveState={saveState}
        />
    );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("shows Saving… while edits upload, Saved for one second, then nothing", () => {
    const { rerender } = render(view(state({})));
    const status = screen.getByRole("status");
    // Nothing to report before the first edit.
    expect(status).toBeEmptyDOMElement();

    rerender(view(state({ dirty: true, status: "pending" })));
    expect(status).toHaveTextContent("Saving…");
    rerender(view(state({ dirty: false, status: "saving" })));
    expect(status).toHaveTextContent("Saving…");

    rerender(view(state({ status: "saved" })));
    expect(status).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(999));
    expect(status).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(1));
    // The live region stays mounted so the next change is announced.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();

    // A later save confirms again.
    rerender(view(state({ dirty: true, status: "pending" })));
    rerender(view(state({ status: "saved" })));
    expect(status).toHaveTextContent("Saved");
});

it("reports a save failure in a warning popup that returns if a retry fails again", () => {
    const failed = state({ status: "error", error: "Your changes could not be saved." });
    const { rerender } = render(view(failed));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
    const popup = screen.getByRole("alert");
    expect(popup).toHaveTextContent("Changes not saved");
    expect(popup).toHaveTextContent("Your changes could not be saved.");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(screen.queryByRole("alert")).toBeNull();
    // The failure is still reported beside the title.
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");

    // Cmd/Ctrl+S retries: the error clears while saving, then fails again.
    rerender(view(state({ status: "saving" })));
    rerender(view(failed));
    expect(screen.getByRole("alert")).toHaveTextContent(
        "Your changes could not be saved.",
    );
});

const webPage = {
    document_id: "web:chat-1:11111111-1111-1111-1111-111111111111",
    title: "Ruling",
    type: "web",
    metadata: [],
    actions: [
        { type: "link", url: "https://example.com/ruling", label: "Open original", title: "Open original page on its site" },
    ],
    quotes: [],
} as unknown as PanelDocument;

function webRow() {
    return <DocumentTitleRow document={webPage} isReloading={false} compactActions={false} />;
}

it("keeps Open original as a plain link in a browser", () => {
    render(webRow());
    expect(screen.getByRole("link", { name: "Open original page on its site" })).toHaveAttribute(
        "href",
        "https://example.com/ruling",
    );
    expect(screen.queryByText("Live page")).toBeNull();
});

it("offers Live page in the native app, opening the Safari view", () => {
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
        PluginHeaders: [{ name: "Browser", methods: [{ name: "open" }] }],
        nativePromise,
    };
    try {
        render(webRow());
        fireEvent.click(screen.getByRole("link", { name: "Open the live page in Safari" }));
        expect(screen.getByText("Live page")).toBeVisible();
        expect(nativePromise).toHaveBeenCalledWith("Browser", "open", { url: "https://example.com/ruling" });
    } finally {
        delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
});
