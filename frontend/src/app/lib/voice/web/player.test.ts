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
});
