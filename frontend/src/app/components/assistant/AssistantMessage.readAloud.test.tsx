import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeSpeech } from "@/app/lib/mikeApi";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type { AssistantEvent } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    synthesizeSpeech: vi.fn(),
}));

const synthesizeMock = vi.mocked(synthesizeSpeech);

class MockAudio {
    src = "";
    preload = "";
    playbackRate = 1;
    currentTime = 0;
    duration = Number.NaN;
    ended = false;
    onplay: (() => void) | null = null;
    onpause: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    ondurationchange: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    removeAttribute = vi.fn((name: string) => {
        if (name === "src") this.src = "";
    });

    constructor() {
        audioInstances.push(this);
    }
}

const audioInstances: MockAudio[] = [];

let urlCounter = 0;

const events: AssistantEvent[] = [
    { type: "content", text: "First sentence. Second sentence." },
];

describe("AssistantMessage read aloud", () => {
    beforeEach(() => {
        audioInstances.length = 0;
        urlCounter = 0;
        synthesizeMock.mockReset();
        synthesizeMock.mockImplementation(
            async (text: string) => new Blob([text], { type: "audio/mpeg" }),
        );
        Object.assign(URL, {
            createObjectURL: vi.fn(() => `blob:read-${++urlCounter}`),
            revokeObjectURL: vi.fn(),
        });
        vi.stubGlobal("Audio", MockAudio);
        vi.stubGlobal(
            "OfflineAudioContext",
            class {
                decodeAudioData(_bytes: ArrayBuffer, ok: (buffer: AudioBuffer) => void) {
                    // 74.85 s of audio: with the 0.15 s pause after it, a 75 s reading.
                    const length = Math.round(24_000 * 74.85);
                    ok({ numberOfChannels: 1, length, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer);
                }
            },
        );
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("prepares the audio, then plays it with a seekable player", async () => {
        const user = userEvent.setup();
        render(<AssistantMessage events={events} />);

        await user.click(
            screen.getByRole("button", { name: "Read response aloud" }),
        );

        expect(
            await screen.findByRole("button", { name: "Pause reading" }),
        ).toBeInTheDocument();
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(synthesizeMock).toHaveBeenCalledWith("First sentence. Second sentence.");
        expect(screen.queryByText(/\d+\/\d+$/)).not.toBeInTheDocument();
        expect(
            screen.getByRole("combobox", { name: "Reading speed" }),
        ).toBeInTheDocument();

        const element = audioInstances[0]!;
        element.currentTime = 12;
        act(() => element.ontimeupdate?.());
        const bar = screen.getByRole("slider", { name: "Reading position" });
        expect(bar).toHaveAttribute("aria-valuetext", "0:12 of 1:15");
        expect(screen.getByText("0:12 / 1:15")).toBeInTheDocument();

        fireEvent.change(bar, { target: { value: "40" } });
        expect(element.currentTime).toBe(40);

        await user.click(screen.getByRole("button", { name: "Pause reading" }));
        expect(element.pause).toHaveBeenCalled();
        await user.click(
            await screen.findByRole("button", { name: "Resume reading" }),
        );
        expect(
            await screen.findByRole("button", { name: "Pause reading" }),
        ).toBeInTheDocument();

        element.ended = true;
        act(() => element.onended?.());
        expect(
            await screen.findByRole("button", { name: "Read response aloud" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("slider", { name: "Reading position" }),
        ).not.toBeInTheDocument();
    });

    it("shows how far preparation has got, and can be stopped", async () => {
        let finish: (blob: Blob) => void = () => {};
        synthesizeMock.mockImplementation(
            () => new Promise<Blob>((resolve) => (finish = resolve)),
        );
        const user = userEvent.setup();
        render(<AssistantMessage events={events} />);

        await user.click(
            screen.getByRole("button", { name: "Read response aloud" }),
        );
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Preparing audio…",
        );
        await user.click(screen.getByRole("button", { name: "Stop reading" }));
        await act(async () => finish(new Blob(["x"])));

        expect(
            screen.getByRole("button", { name: "Read response aloud" }),
        ).toBeInTheDocument();
    });

    it("stops reading on demand and revokes the audio's URL", async () => {
        const user = userEvent.setup();
        render(<AssistantMessage events={events} />);

        await user.click(
            screen.getByRole("button", { name: "Read response aloud" }),
        );
        await waitFor(() =>
            expect(audioInstances[0]?.src).toBe("blob:read-2"),
        );
        await user.click(
            await screen.findByRole("button", { name: "Stop reading" }),
        );

        expect(
            screen.getByRole("button", { name: "Read response aloud" }),
        ).toBeInTheDocument();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:read-2");
    });

    it("hides the read-aloud control while the response streams", () => {
        render(<AssistantMessage events={events} isStreaming />);

        expect(
            screen.queryByRole("button", { name: "Read response aloud" }),
        ).not.toBeInTheDocument();
    });

    it("offers no read-aloud control when there is no prose", () => {
        render(<AssistantMessage events={[]} />);

        expect(
            screen.queryByRole("button", { name: "Read response aloud" }),
        ).not.toBeInTheDocument();
    });
});
