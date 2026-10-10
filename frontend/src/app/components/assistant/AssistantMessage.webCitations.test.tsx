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

afterEach(() => vi.restoreAllMocks());

describe("AssistantMessage web citations", () => {
    it("opens a cited page in a new tab instead of the document panel", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        const onCitationClick = vi.fn();
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Houston won by 18.[1]" }]}
                citations={[web]}
                onCitationClick={onCitationClick}
            />,
        );
        const pills = screen.getAllByRole("button", { name: /Citation 1/ });
        fireEvent.click(pills[0]);
        expect(open).toHaveBeenCalledWith("https://www.rocketswire.com/game", "_blank", "noopener,noreferrer");
        expect(onCitationClick).not.toHaveBeenCalled();
    });

    it("does not open a stored citation whose url is not http(s)", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Text.[1]" }]}
                citations={[{ ...web, url: "javascript:alert(1)" } as Citation]}
                onCitationClick={vi.fn()}
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: /Citation 1/ })[0]);
        expect(open).not.toHaveBeenCalled();
    });
});
