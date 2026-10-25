import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { Citation } from "../shared/types";

const web: Citation = {
    type: "citation_data",
    kind: "web",
    ref: 1,
    url: "https://www.rocketswire.com/game",
    title: "Rockets rout Mavs in Macao",
    site: "rocketswire.com",
    quotes: [{ quote: "Houston won 135-117" }],
};

afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

function installNativeBrowser() {
    const nativePromise = vi.fn().mockResolvedValue(undefined);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
        PluginHeaders: [{ name: "Browser", methods: [{ name: "open" }] }],
        nativePromise,
    };
    return nativePromise;
}

describe("AssistantMessage web citations", () => {
    it("opens a cited page in the host's panel, not on its site", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        const onCitationClick = vi.fn();
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                citations={[web]}
                onCitationClick={onCitationClick}
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: /Citation 1/ })[0]);
        expect(onCitationClick).toHaveBeenCalledWith(web);
        expect(open).not.toHaveBeenCalled();
    });

    it("opens the page on its site, at the quote, when the host has no panel", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                citations={[web]}
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: /Citation 1/ })[0]);
        expect(open).toHaveBeenCalledWith(
            "https://www.rocketswire.com/game#:~:text=Houston%20won%20135%2D117",
            "_blank",
            "noopener,noreferrer",
        );
    });

    it("does not open a stored citation whose url is not http(s)", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Text.[1]" }]}
                citations={[{ ...web, url: "javascript:alert(1)" } as Citation]}
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: /Citation 1/ })[0]);
        expect(open).not.toHaveBeenCalled();
    });

    describe("in the native app", () => {
        it("opens the live page in the Safari view, not the panel", () => {
            const call = installNativeBrowser();
            const onCitationClick = vi.fn();
            render(
                <AssistantMessage
                    events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                    citations={[web]}
                    onCitationClick={onCitationClick}
                />,
            );
            fireEvent.click(screen.getAllByRole("button", { name: /Citation 1/ })[0]);
            expect(call).toHaveBeenCalledWith("Browser", "open", {
                url: "https://www.rocketswire.com/game#:~:text=Houston%20won%20135%2D117",
            });
            expect(onCitationClick).not.toHaveBeenCalled();
        });

        it("offers the saved copy, which opens the panel", () => {
            const call = installNativeBrowser();
            const onCitationClick = vi.fn();
            render(
                <AssistantMessage
                    events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                    citations={[web]}
                    onCitationClick={onCitationClick}
                />,
            );
            fireEvent.click(screen.getByRole("button", { name: /Saved copy of/ }));
            expect(onCitationClick).toHaveBeenCalledWith(web);
            expect(call).not.toHaveBeenCalled();
        });

        it("does not offer the saved copy in a browser", () => {
            render(
                <AssistantMessage
                    events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                    citations={[web]}
                    onCitationClick={vi.fn()}
                />,
            );
            expect(screen.queryByRole("button", { name: /Saved copy of/ })).toBeNull();
        });

        it("opens a link in the answer in the Safari view", () => {
            const call = installNativeBrowser();
            render(
                <AssistantMessage
                    events={[{ type: "content", text: "See [the docs](https://example.com/docs)." }]}
                />,
            );
            fireEvent.click(screen.getByRole("link", { name: "the docs" }));
            expect(call).toHaveBeenCalledWith("Browser", "open", { url: "https://example.com/docs" });
        });
    });
});
