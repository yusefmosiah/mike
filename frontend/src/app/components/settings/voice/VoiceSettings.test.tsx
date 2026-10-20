import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceOptions } from "@/app/lib/mikeApi";

const state = vi.hoisted(() => ({ options: null as unknown, terms: [] as string[] }));

vi.mock("@/app/lib/mikeApi", () => ({
    getVoiceOptions: vi.fn(async () => state.options),
    synthesizeSpeechDetailed: vi.fn(),
    transcribeAudio: vi.fn(),
    getDictationVocabulary: vi.fn(async () => ({ terms: [...state.terms] })),
    saveDictationVocabulary: vi.fn(async (terms: string[]) => {
        state.terms = terms;
        return { terms };
    }),
}));
vi.mock("@/app/lib/voice/browserSpeech", () => ({
    browserSpeechSupported: () => true,
    browserVoices: async () => [],
    installOnDeviceRecognition: vi.fn(),
    onDeviceRecognitionStatus: async () => "unavailable",
    speakWithBrowser: vi.fn(),
}));

import { VoiceSettings } from "./VoiceSettings";
import { resetDictationVocabulary } from "@/app/lib/voice/dictationVocabulary";
import { loadVoicePreferences } from "@/app/lib/voice/preferences";

const catalog = {
    speech: [
        { id: "hexgrad/kokoro-82m", name: "Kokoro 82M", price: { unit: "per_1k_chars", usd: 0.00062 }, voices: ["af_alloy", "af_heart"] },
    ],
    transcription: [
        { id: "qwen/qwen3-asr-0.6b", name: "Qwen3 ASR 0.6B", price: { unit: "per_minute", usd: 0.0002 }, voices: [] },
    ],
};

const options = (overrides: Partial<VoiceOptions> = {}): VoiceOptions => ({
    strict_private: false,
    operator: { transcription: { model: "whisper-large-v3-turbo" }, speech: { model: "tts-1", voice: "alloy" } },
    openrouter: { available: true, catalog: catalog as VoiceOptions["openrouter"]["catalog"] },
    ...overrides,
});

beforeEach(() => {
    window.localStorage.clear();
    state.options = options();
    state.terms = [];
    resetDictationVocabulary();
});
afterEach(() => window.localStorage.clear());

describe("VoiceSettings", () => {
    it("offers the engines this deployment and browser have, with the operator chosen", async () => {
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        const pills = Array.from(dictation.querySelectorAll("button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
        // No on-device recognition in this browser, so "This browser" is not offered for dictation.
        expect(pills).toEqual([
            ["This server", "true"],
            ["OpenRouter", "false"],
            ["Open model in browser", "false"],
        ]);
        expect(screen.getByText(/Uses whisper-large-v3-turbo/)).toBeInTheDocument();
    });

    it("saves an OpenRouter choice and shows model prices", async () => {
        render(<VoiceSettings />);
        const speech = await screen.findByRole("group", { name: "Read-aloud engine" });
        fireEvent.click(Array.from(speech.querySelectorAll("button")).find((b) => b.textContent === "OpenRouter")!);
        await waitFor(() => expect(loadVoicePreferences().speech.engine).toBe("openrouter"));
        expect(screen.getByRole("button", { name: "Read-aloud model" })).toHaveTextContent("Choose a model");
    });

    it("does not offer OpenRouter in strict private mode and says why", async () => {
        state.options = options({ strict_private: true, openrouter: { available: false, reason: "strict_private", catalog: null } });
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        expect(dictation).not.toHaveTextContent("OpenRouter");
        expect(screen.getAllByText(/strict private mode/).length).toBeGreaterThan(0);
    });

    it("asks before setting up a browser model", async () => {
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        fireEvent.click(Array.from(dictation.querySelectorAll("button")).find((b) => b.textContent === "Open model in browser")!);
        expect(await screen.findByRole("button", { name: "Check how long setup takes" })).toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("says so when the saved engine cannot run here", async () => {
        state.options = options({ operator: { transcription: null, speech: null } });
        render(<VoiceSettings />);
        await screen.findByRole("group", { name: "Dictation engine" });
        expect(screen.getAllByRole("status").map((n) => n.textContent)).toEqual([
            "This deployment has no speech server configured. Choose an engine above.",
            "This deployment has no speech server configured. Choose an engine above.",
        ]);
    });
});

describe("VoiceSettings in the iPhone app", () => {
    const nativePromise = vi.fn();
    beforeEach(() => {
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech" }], nativePromise });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        nativePromise.mockReset();
    });

    it("dictates on the phone by default and downloads Apple's model on request", async () => {
        nativePromise.mockImplementation(async (_plugin: string, method: string) =>
            method === "status" ? { state: "downloadable" } : { state: "available" },
        );
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        await waitFor(() =>
            expect(Array.from(dictation.querySelectorAll("button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")])[0])
                .toEqual(["This iPhone", "true"]),
        );
        expect(screen.getByText(/after downloading Apple's speech model/)).toBeInTheDocument();
        nativePromise.mockImplementation(async () => ({ state: "available" }));
        fireEvent.click(screen.getByRole("button", { name: "Download speech model" }));
        await waitFor(() => expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "install", {}));
        expect(await screen.findByText(/the recording never leaves it/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Download speech model" })).not.toBeInTheDocument();
    });

    it("says when the phone's model is downloading", async () => {
        nativePromise.mockResolvedValue({ state: "downloading" });
        render(<VoiceSettings />);
        expect(await screen.findByText(/speech model for this language is downloading/)).toBeInTheDocument();
    });

    describe("in the iPhone app with Fluid Speech Mini", () => {
        const nativePromise = vi.fn(async (_plugin: string, method: string, args?: Record<string, unknown>) =>
            method === "status" && args?.engine === "fluid-mini"
                ? { state: "available", engine: "fluid-mini", locale: "en" }
                : method === "status"
                  ? { state: "available", engine: "speech-analyzer" }
                  : {},
        );
        beforeEach(() => {
            vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "speak" }] }], nativePromise });
        });
        afterEach(() => vi.unstubAllGlobals());

        it("chooses it by default, credits it with a link to the licence, and lets Apple's be chosen", async () => {
            render(<VoiceSettings />);
            const recognizer = await screen.findByRole("group", { name: "Dictation recognizer" });
            const pills = Array.from(recognizer.querySelectorAll("button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
            expect(pills).toEqual([
                ["Fluid Speech Mini", "true"],
                ["Apple", "false"],
            ]);
            const credit = screen.getByRole("link", { name: "Fluid Speech Mini by FluidVoice" });
            expect(credit).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
            fireEvent.click(screen.getByRole("button", { name: "Apple" }));
            await waitFor(() => expect(loadVoicePreferences().transcription).toEqual({ engine: "device", model: "apple" }));
        });
    });
});

describe("VoiceSettings read-aloud with Phonon", () => {
    const pills = (group: HTMLElement) =>
        Array.from(group.querySelectorAll("button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);

    describe("in the browser", () => {
        beforeEach(() => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
        });
        afterEach(() => vi.unstubAllGlobals());

        it("starts the in-browser engine on Phonon, with its voices and the credit", async () => {
            render(<VoiceSettings />);
            const speech = await screen.findByRole("group", { name: "Read-aloud engine" });
            fireEvent.click(Array.from(speech.querySelectorAll("button")).find((b) => b.textContent === "Open model in browser")!);
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "webgpu", model: "phonon" }));
            expect(pills(screen.getByRole("group", { name: "Read-aloud model" }))).toEqual([
                ["Phonon", "true"],
                ["Kokoro", "false"],
            ]);
            expect(screen.getByRole("radio", { name: /Harper/ })).toBeChecked();
            expect(screen.getByText(/Phonon 31M runs in this browser/)).toHaveTextContent("about 65 MB");
            expect(screen.getByRole("link", { name: "Phonon by Gradium" })).toHaveAttribute(
                "href",
                "https://huggingface.co/gradium/phonon-31m-en",
            );
        });

        it("keeps Kokoro for a stored choice with no model, and switches between the two", async () => {
            window.localStorage.setItem("mike.voice.v1", JSON.stringify({ speech: { engine: "webgpu", voice: "bm_george" } }));
            render(<VoiceSettings />);
            const model = await screen.findByRole("group", { name: "Read-aloud model" });
            expect(pills(model)).toEqual([
                ["Phonon", "false"],
                ["Kokoro", "true"],
            ]);
            expect(screen.getByText(/Kokoro 82M runs in this browser/)).toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Phonon by Gradium" })).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole("button", { name: "Phonon" }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "webgpu", model: "phonon" }));
            await userEvent.click(screen.getByRole("radio", { name: /Miles/ }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "webgpu", model: "phonon", voice: "Miles" }));
            fireEvent.click(screen.getByRole("button", { name: "Kokoro" }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "webgpu", model: "kokoro" }));
            await userEvent.click(await screen.findByRole("button", { name: "Read-aloud voice" }));
            await userEvent.click(await screen.findByRole("menuitem", { name: /af_heart/ }));
            await waitFor(() =>
                expect(loadVoicePreferences().speech).toEqual({ engine: "webgpu", model: "kokoro", voice: "af_heart" }),
            );
        });
    });

    describe("in the iPhone app", () => {
        let phonon: { state: string; progress?: number; compiling?: boolean };
        const nativePromise = vi.fn(async (_plugin: string, method: string, args?: Record<string, unknown>) => {
            if (method === "status" && args?.engine === "phonon") return { engine: "phonon", ...phonon };
            if (method === "status") return { state: "available", engine: "speech-analyzer" };
            if (method === "install" && args?.engine === "phonon") {
                phonon = { state: "available" };
                return { engine: "phonon", ...phonon };
            }
            if (method === "remove") {
                phonon = { state: "not-installed" };
                return { engine: "phonon", ...phonon };
            }
            if (method === "voices") return { voices: [{ id: "zoe", name: "Zoe", language: "en-US", quality: "premium" }] };
            return {};
        });
        beforeEach(() => {
            phonon = { state: "not-installed" };
            vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "speak" }] }], nativePromise });
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            nativePromise.mockClear();
        });

        it("reads with Apple's voices until Phonon is downloaded, then downloads it on request and can remove it", async () => {
            render(<VoiceSettings />);
            const voices = await screen.findByRole("group", { name: "Read-aloud voices" });
            expect(pills(voices)).toEqual([
                ["Phonon", "false"],
                ["Apple", "true"],
            ]);
            expect(screen.getByRole("button", { name: "Read-aloud voice" })).toHaveTextContent("The iPhone's default voice");

            fireEvent.click(within(voices).getByRole("button", { name: "Phonon" }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "device", model: "phonon" }));
            expect(await screen.findByText(/Phonon is not on this iPhone yet/)).toHaveTextContent("about 160 MB");
            expect(screen.getByRole("button", { name: "Play a sample of Harper" })).toBeDisabled();
            expect(screen.getByText(/Download Phonon above to hear samples/)).toBeInTheDocument();
            expect(nativePromise).not.toHaveBeenCalledWith("MikeSpeech", "install", { engine: "phonon" });
            expect(screen.getByRole("link", { name: "Phonon by Gradium" })).toBeInTheDocument();

            fireEvent.click(screen.getByRole("button", { name: "Download Phonon" }));
            await waitFor(() => expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "install", { engine: "phonon" }));
            expect(await screen.findByRole("button", { name: "Remove Phonon" })).toBeInTheDocument();
            expect(screen.getByText(/The text never leaves this iPhone/)).toBeInTheDocument();
            expect(screen.getByRole("radio", { name: /Harper/ })).toBeChecked();
            expect(screen.getByRole("button", { name: "Play a sample of Harper" })).toBeEnabled();

            fireEvent.click(screen.getByRole("button", { name: "Remove Phonon" }));
            await waitFor(() => expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "remove", { engine: "phonon" }));
            expect(await screen.findByRole("button", { name: "Download Phonon" })).toBeInTheDocument();
        });

        it("uses Phonon by default once it is downloaded, and Apple's voices when chosen", async () => {
            phonon = { state: "available", compiling: true };
            render(<VoiceSettings />);
            const voices = await screen.findByRole("group", { name: "Read-aloud voices" });
            await waitFor(() =>
                expect(pills(voices)).toEqual([
                    ["Phonon", "true"],
                    ["Apple", "false"],
                ]),
            );
            expect(screen.getByText(/next reading prepares it/)).toBeInTheDocument();
            await userEvent.click(screen.getByRole("radio", { name: /Maeve/ }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "device", model: "phonon", voice: "Maeve" }));

            fireEvent.click(within(voices).getByRole("button", { name: "Apple" }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "device", model: "apple" }));
            expect(screen.getByText(/Phonon is on this iPhone. Choose it above/)).toBeInTheDocument();
            await userEvent.click(screen.getByRole("button", { name: "Read-aloud voice" }));
            await userEvent.click(await screen.findByRole("menuitem", { name: /Zoe/ }));
            await waitFor(() =>
                expect(loadVoicePreferences().speech).toEqual({ engine: "device", model: "apple", voice: "zoe" }),
            );
        });

        it("keeps an Apple voice chosen earlier, with no model stored", async () => {
            window.localStorage.setItem("mike.voice.v1", JSON.stringify({ speech: { engine: "device", voice: "zoe" } }));
            render(<VoiceSettings />);
            const voices = await screen.findByRole("group", { name: "Read-aloud voices" });
            expect(pills(voices)).toEqual([
                ["Phonon", "false"],
                ["Apple", "true"],
            ]);
            await userEvent.click(screen.getByRole("button", { name: "Read-aloud voice" }));
            await userEvent.click(await screen.findByRole("menuitem", { name: /Zoe/ }));
            await waitFor(() => expect(loadVoicePreferences().speech).toEqual({ engine: "device", voice: "zoe" }));
        });

        it("offers only Apple's voices in an app build without Phonon", async () => {
            phonon = { state: "unavailable" };
            render(<VoiceSettings />);
            await screen.findByRole("button", { name: "Read-aloud voice" });
            expect(screen.queryByRole("group", { name: "Read-aloud voices" })).not.toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Phonon by Gradium" })).not.toBeInTheDocument();
        });
    });
});

describe("VoiceSettings vocabulary", () => {
    it("says so when it is empty", async () => {
        render(<VoiceSettings />);
        expect(await screen.findByText(/Names and terms dictation should spell exactly/)).toBeInTheDocument();
        expect(await screen.findByText(/No terms yet/)).toBeInTheDocument();
    });

    it("lists terms alphabetically, adds one and removes one", async () => {
        state.terms = ["Zeta Holdings", "alpha Trust"];
        render(<VoiceSettings />);
        const list = await screen.findByRole("list", { name: "Vocabulary" });
        expect(Array.from(list.querySelectorAll("li")).map((li) => li.firstChild?.textContent)).toEqual([
            "alpha Trust",
            "Zeta Holdings",
        ]);

        fireEvent.change(screen.getByLabelText("New vocabulary term"), { target: { value: "  Ximena   Achterberg " } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() => expect(state.terms).toEqual(["alpha Trust", "Zeta Holdings", "Ximena Achterberg"]));
        expect(await screen.findByText("Ximena Achterberg")).toBeInTheDocument();
        expect(screen.getByLabelText("New vocabulary term")).toHaveValue("");

        fireEvent.click(screen.getByRole("button", { name: "Remove alpha Trust" }));
        await waitFor(() => expect(state.terms).toEqual(["Ximena Achterberg", "Zeta Holdings"]));
    });

    it("refuses a duplicate or a term over four words without saving", async () => {
        state.terms = ["Ximena Achterberg"];
        render(<VoiceSettings />);
        await screen.findByRole("list", { name: "Vocabulary" });
        const input = screen.getByLabelText("New vocabulary term");
        fireEvent.change(input, { target: { value: "ximena achterberg" } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("already in the list");
        fireEvent.change(input, { target: { value: "one two three four five" } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("at most 4 words");
        expect(state.terms).toEqual(["Ximena Achterberg"]);
    });
});
