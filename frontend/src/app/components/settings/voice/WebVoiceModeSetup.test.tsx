import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ voiceRemove: vi.fn() }));
vi.mock("@/app/lib/voice/voiceEngine", async (original) => ({
    ...(await original<typeof import("@/app/lib/voice/voiceEngine")>()),
    voiceRemove: engine.voiceRemove,
}));

import { loadVoicePreferences } from "@/app/lib/voice/preferences";
import { WebVoiceModeSetup } from "./WebVoiceModeSetup";

afterEach(() => {
    window.localStorage.clear();
    engine.voiceRemove.mockReset();
});

describe("WebVoiceModeSetup", () => {
    it("keeps the speech server off until the person allows it", () => {
        render(<WebVoiceModeSetup serverSpeechAvailable />);
        const off = screen.getByRole("button", { name: "This device only" });
        const on = screen.getByRole("button", { name: "Allow the speech server" });
        expect(off).toHaveAttribute("aria-pressed", "true");
        expect(on).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(on);
        expect(loadVoicePreferences().voiceMode).toEqual({ serverSpeech: true });
        expect(screen.getByRole("button", { name: "Allow the speech server" })).toHaveAttribute("aria-pressed", "true");
    });

    it("offers no speech server where the workspace has none", () => {
        render(<WebVoiceModeSetup serverSpeechAvailable={false} />);
        expect(screen.queryByRole("group", { name: "Speech server for voice mode" })).toBeNull();
        expect(screen.getByRole("group", { name: "While it works" })).toBeInTheDocument();
    });

    it("removes voice mode's downloads on request, and says why it could not", async () => {
        engine.voiceRemove.mockResolvedValueOnce({});
        render(<WebVoiceModeSetup serverSpeechAvailable={false} />);
        fireEvent.click(screen.getByRole("button", { name: "Remove voice mode downloads" }));
        expect(await screen.findByText(/download again the next time/)).toBeInTheDocument();
        engine.voiceRemove.mockRejectedValueOnce(new Error("Turn off voice mode before removing its models."));
        fireEvent.click(screen.getByRole("button", { name: "Remove voice mode downloads" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Turn off voice mode"));
    });

    it("never mentions a phone's settings or a download size", () => {
        render(<WebVoiceModeSetup serverSpeechAvailable />);
        const text = document.body.textContent ?? "";
        expect(text).not.toMatch(/iPhone|\bMB\b|\bGB\b/);
    });
});
