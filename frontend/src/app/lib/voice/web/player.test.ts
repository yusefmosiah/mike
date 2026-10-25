import { describe, expect, it, vi } from "vitest";
import { SILENT_WAV, STEP_VOLUME, WebClausePlayer, type AudioLike, type SynthLike } from "./player";

class FakeAudio implements AudioLike {
    src = "";
    volume = 1;
    preload = "";
    currentTime = 0;
    duration = Number.NaN;
    played: string[] = [];
    paused = true;
    private listeners = new Map<string, Set<() => void>>();
    play = vi.fn(() => {
        this.played.push(this.src);
        this.paused = false;
        return Promise.resolve();
    });
    pause = vi.fn(() => {
        this.paused = true;
    });
    load = vi.fn();
    removeAttribute(name: string) {
        if (name === "src") this.src = "";
    }
    addEventListener(type: string, listener: () => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
    }
    fire(type: string) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    }
}

type Utterance = {
    text: string;
    voice: unknown;
    rate: number;
    volume: number;
    onend: (() => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onboundary: ((event: { charIndex: number }) => void) | null;
};

function setup() {
    const audios: FakeAudio[] = [];
    const spoken: Utterance[] = [];
    const cancel = vi.fn();
    const synth: SynthLike = {
        speak: (utterance) => spoken.push(utterance as Utterance),
        cancel,
        getVoices: () => [{ voiceURI: "Samantha" }],
    };
    let urls = 0;
    const revoked: string[] = [];
    const player = new WebClausePlayer({
        createAudio: () => {
            const audio = new FakeAudio();
            audios.push(audio);
            return audio;
        },
        synth,
        createUtterance: (text) => ({ text, voice: null, rate: 1, volume: 1, onend: null, onerror: null, onboundary: null }),
        createObjectURL: () => `blob:${++urls}`,
        revokeObjectURL: (url) => revoked.push(url),
    });
    return { player, audios, spoken, synth, cancel, revoked };
}

const wav = () => new Blob([new Uint8Array(4)], { type: "audio/wav" });

describe("WebClausePlayer", () => {
    it("primes both elements and the system voice inside the tap", () => {
        const { player, audios, spoken } = setup();
        player.prime();
        expect(audios).toHaveLength(2);
        for (const audio of audios) expect(audio.played).toEqual([SILENT_WAV]);
        expect(spoken.map((utterance) => utterance.text)).toEqual([""]);
    });

    it("plays clauses in the two elements by turns, loading the next ahead", async () => {
        const { player, audios, revoked } = setup();
        const first = wav();
        const second = wav();
        const playing = player.play({ kind: "audio", blob: first }, { step: false });
        expect(audios[0].played).toEqual(["blob:1"]);
        player.preload({ kind: "audio", blob: second });
        expect(audios[1].src).toBe("blob:2");
        expect(audios[1].load).toHaveBeenCalled();
        audios[0].fire("ended");
        await playing.ended;
        expect(revoked).toEqual(["blob:1"]);
        const next = player.play({ kind: "audio", blob: second }, { step: true });
        // The preloaded element plays without being loaded again.
        expect(audios[1].played).toEqual(["blob:2"]);
        expect(audios[1].volume).toBe(STEP_VOLUME);
        audios[1].fire("error");
        await next.ended;
    });

    it("stops a clause and says how much of it played", async () => {
        const { player, audios } = setup();
        const playing = player.play({ kind: "audio", blob: wav() }, { step: false });
        audios[0].duration = 4;
        audios[0].currentTime = 1;
        let ended = false;
        void playing.ended.then(() => (ended = true));
        expect(playing.stop()).toBe(0.25);
        expect(audios[0].pause).toHaveBeenCalled();
        expect(audios[0].src).toBe("");
        await Promise.resolve();
        expect(ended).toBe(false);
        expect(playing.stop()).toBe(0);
    });

    it("reads text with the system's voice, with the share spoken from word boundaries", async () => {
        const { player, spoken, cancel } = setup();
        player.voiceURI = "Samantha";
        player.rate = 1.2;
        const text = "Clause four says the rent is due.";
        const playing = player.play({ kind: "utterance", text }, { step: false });
        const utterance = spoken[0];
        expect(utterance.text).toBe(text);
        expect(utterance.voice).toEqual({ voiceURI: "Samantha" });
        expect(utterance.rate).toBe(1.2);
        utterance.onboundary?.({ charIndex: 11 });
        expect(playing.stop()).toBeCloseTo(11 / text.length);
        expect(cancel).toHaveBeenCalled();

        const next = player.play({ kind: "utterance", text: "Done." }, { step: true });
        expect(spoken[1].volume).toBe(STEP_VOLUME);
        spoken[1].onend?.();
        await next.ended;
    });

    it("has nothing to play for a clause without audio", async () => {
        const { player } = setup();
        const playing = player.play({ kind: "none" }, { step: false });
        await playing.ended;
        expect(playing.stop()).toBe(1);
    });

    it("builds its own parts when none are given, and has no system voice without speechSynthesis", () => {
        const created: unknown[] = [];
        vi.stubGlobal(
            "Audio",
            class {
                constructor() {
                    created.push(this);
                }
            },
        );
        vi.stubGlobal("window", {});
        try {
            const player = new WebClausePlayer();
            expect(created).toHaveLength(2);
            player.prime();
            const spoken = player.play({ kind: "utterance", text: "Hi." }, { step: false });
            expect(spoken.stop()).toBe(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("has no system voice without a window", () => {
        vi.stubGlobal("Audio", class {});
        vi.stubGlobal("window", undefined);
        try {
            const player = new WebClausePlayer();
            expect(player.play({ kind: "utterance", text: "Hi." }, { step: false }).stop()).toBe(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("uses the window's speechSynthesis, utterances and the URL functions by default", () => {
        const speak = vi.fn();
        const synth = { speak, cancel: vi.fn(), getVoices: () => [] };
        vi.stubGlobal("window", { speechSynthesis: synth });
        vi.stubGlobal("Audio", class {});
        vi.stubGlobal(
            "SpeechSynthesisUtterance",
            class {
                constructor(public text: string) {}
            },
        );
        const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:default");
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        try {
            const player = new WebClausePlayer();
            player.prime();
            expect(speak).toHaveBeenCalledTimes(1);
            expect(speak.mock.calls[0][0].text).toBe("");
        } finally {
            create.mockRestore();
            revoke.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it("loads and revokes through the URL functions by default", () => {
        const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:default");
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        try {
            const player = new WebClausePlayer({ createAudio: () => new FakeAudio(), synth: null });
            const blob = wav();
            player.preload({ kind: "audio", blob });
            expect(create).toHaveBeenCalledWith(blob);
            player.preload({ kind: "audio", blob: wav() });
            expect(revoke).toHaveBeenCalledWith("blob:default");
        } finally {
            create.mockRestore();
            revoke.mockRestore();
        }
    });

    it("ignores a preload for text and keeps playing when a refusal or throw comes from the element", async () => {
        const { player, audios, revoked } = setup();
        player.preload({ kind: "utterance", text: "Not audio." });
        expect(audios[0].load).not.toHaveBeenCalled();
        // A refused prime does not matter, whether it rejects or throws.
        audios[0].play.mockImplementationOnce(() => Promise.reject(new Error("blocked")));
        audios[1].play.mockImplementationOnce(() => {
            throw new Error("blocked");
        });
        expect(() => player.prime()).not.toThrow();
        // A refused play ends the clause as if it had finished.
        audios[0].play.mockImplementationOnce(() => Promise.reject(new Error("blocked")));
        const refused = player.play({ kind: "audio", blob: wav() }, { step: false });
        await refused.ended;
        audios[1].play.mockImplementationOnce(() => {
            throw new Error("blocked");
        });
        const thrown = player.play({ kind: "audio", blob: wav() }, { step: false });
        await thrown.ended;
        expect(revoked).toHaveLength(2);
    });

    it("primes without a system voice, and survives one that throws", () => {
        const none = new WebClausePlayer({ createAudio: () => new FakeAudio(), synth: null });
        expect(() => none.prime()).not.toThrow();
        none.reset();
        const throwing: SynthLike = {
            speak: () => {
                throw new Error("no voice");
            },
            cancel: () => {
                throw new Error("nothing");
            },
            getVoices: () => [],
        };
        const player = new WebClausePlayer({
            createAudio: () => new FakeAudio(),
            synth: throwing,
            createUtterance: (text) => ({ text, voice: null, rate: 1, volume: 1, onend: null, onerror: null, onboundary: null }),
        });
        expect(() => player.prime()).not.toThrow();
        expect(() => player.reset()).not.toThrow();
    });

    it("clamps the share heard and ignores an unknown duration or voice", () => {
        const { player, audios } = setup();
        const long = player.play({ kind: "audio", blob: wav() }, { step: false });
        audios[0].duration = 2;
        audios[0].currentTime = 5;
        expect(long.stop()).toBe(1);
        const unknown = player.play({ kind: "audio", blob: wav() }, { step: false });
        audios[1].duration = Number.POSITIVE_INFINITY;
        expect(unknown.stop()).toBe(0);

        player.voiceURI = "Missing";
        const spoken = player.play({ kind: "utterance", text: "" }, { step: false });
        expect(spoken.stop()).toBe(0);
    });

    it("speaks nothing when there is no system voice, and an utterance error ends the clause", async () => {
        const quiet = new WebClausePlayer({ createAudio: () => new FakeAudio(), synth: null });
        const playing = quiet.play({ kind: "utterance", text: "Hello." }, { step: false });
        await playing.ended;
        expect(playing.stop()).toBe(1);

        const { player, spoken } = setup();
        const failing = player.play({ kind: "utterance", text: "Oops." }, { step: false });
        spoken[0].onerror?.({ error: "synthesis-failed" });
        await failing.ended;

        // Events that arrive after a stop settle nothing.
        const stopped = player.play({ kind: "utterance", text: "Stopped." }, { step: false });
        let settled = false;
        void stopped.ended.then(() => (settled = true));
        stopped.stop();
        spoken[1].onend?.();
        spoken[1].onerror?.({ error: "canceled" });
        await Promise.resolve();
        expect(settled).toBe(false);
    });

    it("resets both elements and forgets what was loaded ahead", () => {
        const { player, audios, revoked, cancel } = setup();
        player.preload({ kind: "audio", blob: wav() });
        player.reset();
        for (const audio of audios) expect(audio.pause).toHaveBeenCalled();
        expect(revoked).toEqual(["blob:1"]);
        expect(cancel).toHaveBeenCalled();
    });
});
