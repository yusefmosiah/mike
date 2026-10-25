import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceAppModal } from "./VoiceAppModal";

describe("VoiceAppModal", () => {
    it("renders nothing while closed", () => {
        render(<VoiceAppModal open={false} appUrl={null} onClose={vi.fn()} onUseBrowser={vi.fn()} />);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("says voice mode works best in the app, with a link to get it and the browser option", () => {
        const onUseBrowser = vi.fn();
        render(<VoiceAppModal open appUrl="https://apps.example/get" onClose={vi.fn()} onUseBrowser={onUseBrowser} />);
        expect(screen.getByRole("dialog", { name: "Voice mode" })).toBeInTheDocument();
        expect(screen.getByText(/works best in the app/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Get the app" })).toHaveAttribute("href", "https://apps.example/get");
        fireEvent.click(screen.getByRole("button", { name: "Use voice mode in this browser" }));
        expect(onUseBrowser).toHaveBeenCalledTimes(1);
    });

    it("leaves out the app link when none is configured", () => {
        render(<VoiceAppModal open appUrl={null} onClose={vi.fn()} onUseBrowser={vi.fn()} />);
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getByRole("button", { name: "Use voice mode in this browser" })).toBeInTheDocument();
    });

    it("closes with Escape", () => {
        const onClose = vi.fn();
        render(<VoiceAppModal open appUrl={null} onClose={onClose} onUseBrowser={vi.fn()} />);
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });
});
