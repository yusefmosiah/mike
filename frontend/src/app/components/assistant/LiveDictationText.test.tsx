import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveDictationText } from "./LiveDictationText";

describe("LiveDictationText", () => {
    it("shows confirmed text normally and the volatile tail muted, only the confirmed text live", () => {
        const { container } = render(<LiveDictationText confirmed="Hello there" volatile="how are" />);
        const confirmed = screen.getByText("Hello there");
        expect(confirmed).toHaveAttribute("aria-live", "polite");
        expect(confirmed.className).toContain("text-foreground");
        const tail = screen.getByText(/how are/);
        expect(tail).not.toHaveAttribute("aria-live");
        expect(tail.className).toContain("text-muted-foreground");
        const area = container.querySelector('[data-slot="live-dictation-text"]') as HTMLElement;
        expect(area.className).toContain("max-h-28");
        expect(area.className).toContain("overflow-y-auto");
    });

    it("says it is listening before any text, and scrolls to the end as text grows", () => {
        const { container, rerender } = render(<LiveDictationText confirmed="" volatile="" />);
        expect(screen.getByText("Listening…")).toBeInTheDocument();
        const area = container.querySelector('[data-slot="live-dictation-text"]') as HTMLElement;
        Object.defineProperty(area, "scrollHeight", { configurable: true, value: 500 });
        rerender(<LiveDictationText confirmed="" volatile="first words" />);
        expect(screen.queryByText("Listening…")).toBeNull();
        expect(area.scrollTop).toBe(500);
    });
});
