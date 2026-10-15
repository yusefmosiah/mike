import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelDocument } from "../types";
import { WebPageView } from "./WebPageView";

const { getChatWebPage } = vi.hoisted(() => ({ getChatWebPage: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ getChatWebPage }));

const SNAPSHOT = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
const document: PanelDocument = {
    document_id: `web:chat-1:${SNAPSHOT}`,
    title: "Ruling on appeal",
    type: "web",
    metadata: [],
    quotes: [],
};
const page = {
    id: SNAPSHOT,
    url: "https://example.com/ruling",
    text: "Ruling on appeal. The court held for the appellant.",
    markdown: "## Ruling on appeal\n\nThe court **held** for the [appellant](https://example.com/a).",
    retrieved_at: "2026-10-12T09:00:00.000Z",
};

beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.clearAllMocks());

describe("WebPageView", () => {
    it("shows the saved page as rendered Markdown with the cited quote highlighted", async () => {
        getChatWebPage.mockResolvedValue(page);
        const { container } = render(
            <WebPageView
                document={document}
                activeQuote={{ quote: "The court held for the appellant", target: {} }}
            />,
        );

        expect(screen.getByRole("status", { name: "Loading page" })).toBeInTheDocument();
        expect(await screen.findByRole("heading", { name: "Ruling on appeal" })).toBeInTheDocument();
        expect(getChatWebPage).toHaveBeenCalledWith("chat-1", SNAPSHOT);
        expect(screen.getByRole("link", { name: "appellant" })).toHaveAttribute("href", "https://example.com/a");
        await waitFor(() =>
            expect(container.querySelector(".case-quote-highlight")?.textContent).toContain("The court"),
        );
        await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    });

    it("highlights a quote copied from the Markdown, link targets and all", async () => {
        getChatWebPage.mockResolvedValue(page);
        const { container } = render(
            <WebPageView
                document={document}
                activeQuote={{ quote: "The court **held** for the [appellant](https://example.com/a)", target: {} }}
            />,
        );
        await waitFor(() =>
            expect(
                [...container.querySelectorAll(".case-quote-highlight")]
                    .map((element) => element.textContent)
                    .join("")
                    .replace(/\s/g, ""),
            ).toBe("Thecourtheldfortheappellant"),
        );
    });

    it("shows the plain text when no article could be extracted, and leaves an unmatched quote alone", async () => {
        getChatWebPage.mockResolvedValue({ ...page, markdown: null });
        const { container } = render(
            <WebPageView document={document} activeQuote={{ quote: "nothing like this", target: {} }} />,
        );
        expect(await screen.findByText(page.text)).toBeInTheDocument();
        expect(container.querySelector(".case-quote-highlight")).toBeNull();
    });

    it("explains a citation that has no saved page, without asking for one", () => {
        render(<WebPageView document={{ ...document, document_id: "web:https://example.com/ruling" }} />);
        expect(screen.getByText(/No copy of this page was saved/)).toBeInTheDocument();
        expect(getChatWebPage).not.toHaveBeenCalled();
    });

    it("offers to try again when the page cannot be loaded", async () => {
        getChatWebPage.mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValueOnce(page);
        render(<WebPageView document={document} />);

        expect(await screen.findByRole("alert")).toHaveTextContent("The saved page could not be loaded.");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(screen.getByRole("status", { name: "Loading page" })).toBeInTheDocument();
        expect(await screen.findByRole("heading", { name: "Ruling on appeal" })).toBeInTheDocument();
        expect(getChatWebPage).toHaveBeenCalledTimes(2);
    });
});
