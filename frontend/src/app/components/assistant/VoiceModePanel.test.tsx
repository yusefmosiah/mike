import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatDownloadSize, VoiceModePanel } from "./VoiceModePanel";
import type { UseVoiceChatResult } from "@/app/hooks/useVoiceChat";

function voice(overrides: Partial<UseVoiceChatResult> = {}) {
    return {
        phase: "on",
        activity: "listening",
        partial: "",
        installProgress: null,
        downloadBytes: 0,
        error: null,
        install: vi.fn(async () => undefined),
        stop: vi.fn(),
        ...overrides,
    } as UseVoiceChatResult;
}

describe("formatDownloadSize", () => {
    it("says the size in round figures", () => {
        expect(formatDownloadSize(0)).toBe("about 1 MB");
        expect(formatDownloadSize(452_300_000)).toBe("about 452 MB");
        expect(formatDownloadSize(1_240_000_000)).toBe("about 1.2 GB");
    });
});

describe("VoiceModePanel", () => {
    it("shows the state in words and in shape, with the live words and one End control", () => {
        const handlers = voice({ partial: "what does clause four say" });
        const { rerender } = render(<VoiceModePanel voice={handlers} />);
        expect(screen.getByRole("region", { name: "Voice mode" })).toBeInTheDocument();
        expect(screen.getByTestId("voice-activity")).toHaveTextContent("Listening");
        expect(screen.getByText("what does clause four say")).toBeInTheDocument();
        expect(document.querySelector("[data-activity='listening']")).toHaveAttribute("aria-hidden", "true");
        // Nothing here is announced while the answer is spoken.
        expect(document.querySelector("[aria-live]")).toBeNull();
        expect(screen.getAllByRole("button")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "End" }));
        expect(handlers.stop).toHaveBeenCalled();

        rerender(<VoiceModePanel voice={voice({ activity: "thinking" })} />);
        expect(screen.getByTestId("voice-activity")).toHaveTextContent("Thinking");
        expect(document.querySelector("[data-activity='thinking']")).not.toBeNull();
        expect(screen.getByText("Speak to interrupt.")).toBeInTheDocument();
        rerender(<VoiceModePanel voice={voice({ activity: "speaking" })} />);
        expect(screen.getByTestId("voice-activity")).toHaveTextContent("Speaking");
        expect(document.querySelector("[data-activity='speaking']")).not.toBeNull();
        rerender(<VoiceModePanel voice={voice()} />);
        expect(screen.getByText("Speak when you’re ready.")).toBeInTheDocument();
    });

    it("shows a starting state that can be cancelled", () => {
        const handlers = voice({ phase: "starting" });
        const { rerender } = render(<VoiceModePanel voice={handlers} />);
        expect(screen.getByText("Starting voice mode…")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(handlers.stop).toHaveBeenCalled();
        rerender(<VoiceModePanel voice={voice({ phase: "checking" })} />);
        expect(screen.getByText("Starting voice mode…")).toBeInTheDocument();
    });

    it("offers the model download with its size, and shows why it failed", () => {
        const handlers = voice({ phase: "setup", downloadBytes: 420e6, error: "Could not download the speech models." });
        const { rerender } = render(<VoiceModePanel voice={handlers} />);
        expect(screen.getByRole("button", { name: "Download" })).toHaveFocus();
        expect(screen.getByRole("region", { name: "Voice mode setup" })).toHaveTextContent("about 420 MB");
        expect(screen.getByRole("alert")).toHaveTextContent("Could not download the speech models.");
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(handlers.install).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(handlers.stop).toHaveBeenCalled();
        rerender(<VoiceModePanel voice={{ ...handlers, phase: "installing" }} />);
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        rerender(<VoiceModePanel voice={{ ...handlers, phase: "on" }} />);
        expect(screen.getByRole("button", { name: "End" })).toHaveFocus();
    });

    it("shows the download's progress, then that the phone is preparing the models", () => {
        const { rerender } = render(<VoiceModePanel voice={voice({ phase: "installing", installProgress: 0.42 })} />);
        const bar = screen.getByRole("progressbar", { name: "Downloading speech models" });
        expect(bar).toHaveAttribute("aria-valuenow", "42");
        expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
        rerender(<VoiceModePanel voice={voice({ phase: "installing", installProgress: 1 })} />);
        expect(screen.getByRole("progressbar", { name: "Preparing speech models" })).not.toHaveAttribute("aria-valuenow");
        expect(screen.getByText("Preparing for this phone…")).toBeInTheDocument();
        rerender(<VoiceModePanel voice={voice({ phase: "installing", installProgress: null })} />);
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    });
});
