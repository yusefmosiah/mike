import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FullScreenLoader } from "./FullScreenLoader";

describe("FullScreenLoader", () => {
    it("announces loading and carries a reload link for a load that stalls", () => {
        render(<FullScreenLoader />);

        expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
        expect(
            screen.getByText("This is taking longer than usual.").parentElement,
        ).toHaveClass("slow-load-notice");
        // An empty href is a plain navigation to the current page: it works
        // even when the page's scripts never ran.
        expect(
            screen.getByText("Try again").closest("a"),
        ).toHaveAttribute("href", "");
    });
});
