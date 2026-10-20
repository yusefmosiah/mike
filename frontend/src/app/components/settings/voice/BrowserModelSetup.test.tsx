import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BrowserModelsModule from "@/app/lib/voice/browserModels";

const models = vi.hoisted(() => ({
    estimate: vi.fn(async () => 2),
    loadTranscriber: vi.fn(),
    loadPhonon: vi.fn(),
    loadSpeaker: vi.fn(),
}));

vi.mock("@/app/lib/voice/browserModels", async (importOriginal) => ({
    ...(await importOriginal<typeof BrowserModelsModule>()),
    estimateBrowserModelSetup: models.estimate,
    loadBrowserTranscriber: models.loadTranscriber,
    loadBrowserPhonon: models.loadPhonon,
    loadBrowserSpeaker: models.loadSpeaker,
}));

import { BrowserModelError, BROWSER_MODEL_RESTARTED_MESSAGE } from "@/app/lib/voice/browserModels";
import { BrowserModelSetup } from "./BrowserModelSetup";

const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

beforeEach(() => {
    window.localStorage.clear();
    models.loadTranscriber.mockReset();
    models.loadPhonon.mockReset();
    models.loadSpeaker.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

async function setUp() {
    fireEvent.click(screen.getByRole("button", { name: "Check how long setup takes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set up Whisper Base" }));
}

describe("BrowserModelSetup", () => {
    it("says the iPhone runs the model on WebAssembly, not WebGPU", () => {
        vi.stubGlobal("navigator", { userAgent: IPHONE, gpu: {}, maxTouchPoints: 5 });
        render(<BrowserModelSetup kind="transcription" />);
        expect(
            screen.getByText(/Whisper Base runs in this browser on WebAssembly \(WebGPU is not used in this browser\)/),
        ).toBeInTheDocument();
    });

    it("keeps WebGPU in Chrome", () => {
        vi.stubGlobal("navigator", { userAgent: CHROME, gpu: {} });
        render(<BrowserModelSetup kind="transcription" />);
        expect(screen.getByText(/Whisper Base runs in this browser on WebGPU\./)).toBeInTheDocument();
    });

    it("says WebAssembly is slower where there is no WebGPU", () => {
        vi.stubGlobal("navigator", { userAgent: CHROME });
        render(<BrowserModelSetup kind="transcription" />);
        expect(screen.getByText(/on WebAssembly \(slower; this browser has no WebGPU\)/)).toBeInTheDocument();
    });

    it("shows why setup stopped when the page restarted during the last run", async () => {
        vi.stubGlobal("navigator", { userAgent: IPHONE });
        models.loadTranscriber.mockRejectedValue(new BrowserModelError(BROWSER_MODEL_RESTARTED_MESSAGE));
        render(<BrowserModelSetup kind="transcription" />);
        await setUp();
        expect(await screen.findByRole("alert")).toHaveTextContent(BROWSER_MODEL_RESTARTED_MESSAGE);
    });

    it("keeps library errors out of the page", async () => {
        vi.stubGlobal("navigator", { userAgent: IPHONE });
        models.loadTranscriber.mockRejectedValue(new Error("no available backend found. ERR: [wasm] RangeError"));
        render(<BrowserModelSetup kind="transcription" />);
        await setUp();
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Setup did not finish. Check the connection and try again.",
        );
    });

    it("sets up Phonon, saying the size and that the GPU is used where there is one", async () => {
        vi.stubGlobal("navigator", { userAgent: CHROME, gpu: {} });
        models.loadPhonon.mockImplementation(async (onProgress: (fraction: number) => void) => onProgress(0.5));
        render(<BrowserModelSetup kind="phonon" />);
        expect(screen.getByText(/Phonon 31M runs in this browser on WebGPU where this browser has it/)).toHaveTextContent(
            "(about 65 MB)",
        );
        fireEvent.click(screen.getByRole("button", { name: "Check how long setup takes" }));
        fireEvent.click(await screen.findByRole("button", { name: "Set up Phonon 31M" }));
        expect(await screen.findByText("Set up on this device.")).toBeInTheDocument();
        expect(models.loadPhonon).toHaveBeenCalled();
        expect(models.loadSpeaker).not.toHaveBeenCalled();
    });

    it("sets up Kokoro with its own loader", async () => {
        vi.stubGlobal("navigator", { userAgent: CHROME, gpu: {} });
        models.loadSpeaker.mockResolvedValue(undefined);
        render(<BrowserModelSetup kind="speech" />);
        fireEvent.click(screen.getByRole("button", { name: "Check how long setup takes" }));
        fireEvent.click(await screen.findByRole("button", { name: "Set up Kokoro 82M" }));
        expect(await screen.findByText("Set up on this device.")).toBeInTheDocument();
        expect(models.loadSpeaker).toHaveBeenCalled();
    });

    it("tells its parent when the model becomes ready, fails, or is turned off", async () => {
        vi.stubGlobal("navigator", { userAgent: CHROME, gpu: {} });
        const onReadyChange = vi.fn();
        models.loadTranscriber.mockRejectedValueOnce(new Error("x"));
        render(<BrowserModelSetup kind="transcription" onReadyChange={onReadyChange} />);
        await setUp();
        await screen.findByRole("alert");
        expect(onReadyChange).toHaveBeenLastCalledWith(false);
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        models.loadTranscriber.mockResolvedValueOnce(undefined);
        await setUp();
        await screen.findByRole("button", { name: "Stop using it" });
        expect(onReadyChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(screen.getByRole("button", { name: "Stop using it" }));
        expect(onReadyChange).toHaveBeenLastCalledWith(false);
    });
});
