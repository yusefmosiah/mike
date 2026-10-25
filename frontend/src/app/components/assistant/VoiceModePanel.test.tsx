import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDownloadSize, VoiceModePanel } from "./VoiceModePanel";
import type { UseVoiceChatResult } from "@/app/hooks/useVoiceChat";
import { CHAT_COMPOSER_SURFACE_CLASS } from "./composerSurface";

function voice(overrides: Partial<UseVoiceChatResult> = {}) {
    return {
        phase: "on",
        activity: "listening",
        partial: "",
        ignoredOtherVoice: false,
        installProgress: null,
        downloadBytes: 0,
        preparation: { preparing: false, firstTime: false },
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
    afterEach(() => vi.unstubAllGlobals());

    it("says a turn in another voice was not sent, until the person speaks", () => {
        const { rerender } = render(<VoiceModePanel voice={voice({ ignoredOtherVoice: true })} />);
        expect(screen.getByText("Another voice, not sent.")).toBeInTheDocument();
        rerender(<VoiceModePanel voice={voice({ ignoredOtherVoice: true, partial: "as I was saying" })} />);
        expect(screen.getByText("as I was saying")).toBeInTheDocument();
        expect(screen.queryByText("Another voice, not sent.")).not.toBeInTheDocument();
    });

    it("opens the phone's microphone modes where the app has them", () => {
        const nativePromise = vi.fn(async () => undefined);
        vi.stubGlobal("Capacitor", {
            PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "voiceStatus" }, { name: "voiceMicrophoneModes" }] }],
            nativePromise,
        });
        render(<VoiceModePanel voice={voice()} />);
        fireEvent.click(screen.getByRole("button", { name: "Microphone mode" }));
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceMicrophoneModes", undefined);
        expect(screen.getByRole("button", { name: "End" })).toBeInTheDocument();
    });

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

    it("says the models are being prepared for first use, politely, until they are", () => {
        const { rerender } = render(<VoiceModePanel voice={voice({ phase: "starting", preparation: { preparing: true, firstTime: true } })} />);
        const status = screen.getByRole("status");
        expect(status).toHaveAttribute("aria-live", "polite");
        expect(status).toHaveTextContent("Preparing voice mode for first use…");
        expect(status).toHaveTextContent("once after an install or an update");
        expect(screen.queryByText("Starting voice mode…")).not.toBeInTheDocument();
        // The same region carries the later text, so the change is announced.
        rerender(<VoiceModePanel voice={voice({ phase: "starting", preparation: { preparing: true, firstTime: false } })} />);
        expect(screen.getByRole("status")).toHaveTextContent("Starting voice mode…");
        expect(screen.getByRole("status")).not.toHaveTextContent("once after");
        rerender(<VoiceModePanel voice={voice({ phase: "checking", preparation: { preparing: false, firstTime: true } })} />);
        expect(screen.getByRole("status")).toHaveTextContent("Starting voice mode…");
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

    it("in a browser, says the download in minutes, how voice mode runs here, and never a phone or a size", () => {
        const sentence = "Voice mode runs on this device, using its graphics processor. What you say stays in this browser.";
        render(
            <VoiceModePanel
                voice={voice({ phase: "setup", inBrowser: true, downloadBytes: 273e6, downloadMinutes: 4, sentence })}
            />,
        );
        const frame = document.querySelector("[data-slot='voice-mode-panel']")!;
        expect(frame).toHaveTextContent("Voice mode needs speech models in this browser (about 4 minutes to download, once).");
        expect(frame).toHaveTextContent(sentence);
        expect(frame.textContent).not.toMatch(/\bphone\b|iPhone|MB|GB/);
    });

    it("in a browser, says it is getting ready rather than preparing for a phone", () => {
        render(<VoiceModePanel voice={voice({ phase: "installing", installProgress: 1, inBrowser: true })} />);
        expect(screen.getByText("Getting ready…")).toBeInTheDocument();
    });

    it("in a browser, offers Tap to interrupt while the answer is awaited or spoken", () => {
        const interrupt = vi.fn();
        const { rerender } = render(<VoiceModePanel voice={voice({ inBrowser: true, interrupt })} />);
        expect(screen.queryByRole("button", { name: "Tap to interrupt" })).toBeNull();
        rerender(<VoiceModePanel voice={voice({ inBrowser: true, interrupt, activity: "speaking" })} />);
        expect(screen.getByText("Not listening while it speaks.")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: "Tap to interrupt" });
        expect(button).toHaveAttribute("type", "button");
        fireEvent.click(button);
        expect(interrupt).toHaveBeenCalledTimes(1);
        rerender(<VoiceModePanel voice={voice({ inBrowser: true, interrupt, activity: "thinking" })} />);
        expect(screen.getByText("Speak, or tap to interrupt.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Tap to interrupt" })).toBeInTheDocument();
        // The iPhone app's engine hears the person over its answer: no button there.
        rerender(<VoiceModePanel voice={voice({ interrupt, activity: "speaking" })} />);
        expect(screen.queryByRole("button", { name: "Tap to interrupt" })).toBeNull();
        expect(screen.getByText("Speak to interrupt.")).toBeInTheDocument();
    });

    it("has the composer's surface and resting envelope in every step, including while starting", () => {
        const { rerender } = render(<VoiceModePanel voice={voice({ phase: "checking" })} />);
        for (const phase of ["checking", "starting", "setup", "installing", "on"] as const) {
            rerender(<VoiceModePanel voice={voice({ phase })} />);
            const frame = document.querySelector("[data-slot='voice-mode-panel']");
            for (const name of [...CHAT_COMPOSER_SURFACE_CLASS.split(" "), "min-h-[100px]", "pt-4", "pl-4", "pr-2.5", "pb-2.5"]) {
                expect(frame).toHaveClass(name);
            }
        }
    });
});
