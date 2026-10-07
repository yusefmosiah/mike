import { act, render, screen, waitFor } from "@testing-library/react";
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

    it("reads the response aloud and advances sentence by sentence", async () => {
        const user = userEvent.setup();
        render(<AssistantMessage events={events} />);

        await user.click(
            screen.getByRole("button", { name: "Read response aloud" }),
        );

        await waitFor(() =>
            expect(synthesizeMock).toHaveBeenCalledWith("First sentence."),
        );
        expect(
            await screen.findByRole("button", { name: "Stop reading" }),
        ).toBeInTheDocument();
        expect(screen.getByText("1/2")).toBeInTheDocument();
        expect(
            screen.getByRole("combobox", { name: "Reading speed" }),
        ).toBeInTheDocument();

        await act(async () => {
            audioInstances[0]?.onended?.();
        });
        expect(await screen.findByText("2/2")).toBeInTheDocument();

        await act(async () => {
            audioInstances[0]?.onended?.();
        });

        expect(
            await screen.findByRole("button", { name: "Read response aloud" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("2/2")).not.toBeInTheDocument();
    });

    it("stops reading on demand and revokes the object URL", async () => {
        const user = userEvent.setup();
        render(<AssistantMessage events={events} />);

        await user.click(
            screen.getByRole("button", { name: "Read response aloud" }),
        );
        await waitFor(() =>
            expect(audioInstances[0]?.src).toBe("blob:read-1"),
        );
        await user.click(
            await screen.findByRole("button", { name: "Stop reading" }),
        );

        expect(
            screen.getByRole("button", { name: "Read response aloud" }),
        ).toBeInTheDocument();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:read-1");
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
