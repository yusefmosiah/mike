/**
 * Plays voice mode's clauses in the browser (docs/voice-web.md). Rendered
 * audio goes through two `<audio>` elements used in turn, the next clause
 * loading in one while the other plays, not through Web Audio: Chrome's echo
 * canceller is reported to cancel media elements but not Web Audio output.
 * Text for the system's voice goes to `speechSynthesis`.
 *
 * Browsers only let a page start audio from a tap: `prime()` runs inside the
 * voice button's tap and plays a moment of silence on both elements (and an
 * empty utterance), which unlocks them for the rest of the session.
 */

import type { ClausePlayback, ClausePlayer, RenderedClause } from "./clauseQueue";

/** The parts of an `<audio>` element this module uses. */
export interface AudioLike {
    src: string;
    volume: number;
    preload: string;
    currentTime: number;
    duration: number;
    play(): Promise<void> | void;
    pause(): void;
    load(): void;
    removeAttribute(name: string): void;
    addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: string, listener: () => void): void;
}

interface UtteranceLike {
    text: string;
    voice: unknown;
    rate: number;
    volume: number;
    onend: (() => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onboundary: ((event: { charIndex: number }) => void) | null;
}

export interface SynthLike {
    speak(utterance: UtteranceLike): void;
    cancel(): void;
    getVoices(): { voiceURI: string }[];
}

export interface PlayerDeps {
    createAudio?: () => AudioLike;
    synth?: SynthLike | null;
    createUtterance?: (text: string) => UtteranceLike;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
}

/** 10 ms of 16 kHz silence as a WAV data URL: what `prime()` plays. */
export const SILENT_WAV =
    "data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** Steps said while the answer works are a little quieter than the answer. */
export const STEP_VOLUME = 0.75;

export class WebClausePlayer implements ClausePlayer {
    private readonly elements: [AudioLike, AudioLike];
    /** The element the next clause plays in. */
    private turn = 0;
    private preloaded: { blob: Blob; url: string } | null = null;
    private readonly deps: Required<Omit<PlayerDeps, "synth">> & { synth: SynthLike | null };
    voiceURI: string | undefined;
    rate: number | undefined;

    constructor(deps: PlayerDeps = {}) {
        this.deps = {
            createAudio: deps.createAudio ?? (() => new Audio() as unknown as AudioLike),
            synth:
                deps.synth !== undefined
                    ? deps.synth
                    : typeof window !== "undefined" && "speechSynthesis" in window
                      ? (window.speechSynthesis as unknown as SynthLike)
                      : null,
            createUtterance: deps.createUtterance ?? ((text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike),
            createObjectURL: deps.createObjectURL ?? ((blob) => URL.createObjectURL(blob)),
            revokeObjectURL: deps.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url)),
        };
        this.elements = [this.deps.createAudio(), this.deps.createAudio()];
    }

    /** Unlocks playback; call synchronously inside the person's tap. */
    prime(): void {
        for (const element of this.elements) {
            element.src = SILENT_WAV;
            try {
                void Promise.resolve(element.play()).catch(() => undefined);
            } catch {
                // Refused: the first clause will try again.
            }
        }
        try {
            if (this.deps.synth) this.deps.synth.speak(this.deps.createUtterance(""));
        } catch {
            // No system voice to unlock.
        }
    }

    preload(clause: RenderedClause): void {
        if (clause.kind !== "audio") return;
        this.dropPreloaded();
        const element = this.elements[this.turn];
        const url = this.deps.createObjectURL(clause.blob);
        element.preload = "auto";
        element.src = url;
        element.load();
        this.preloaded = { blob: clause.blob, url };
    }

    play(clause: RenderedClause, options: { step: boolean }): ClausePlayback {
        if (clause.kind === "utterance") return this.speak(clause.text, options.step);
        if (clause.kind !== "audio") return { ended: Promise.resolve(), stop: () => 1 };
        const element = this.elements[this.turn];
        this.turn = 1 - this.turn;
        let url: string;
        if (this.preloaded?.blob === clause.blob) {
            url = this.preloaded.url;
            this.preloaded = null;
        } else {
            url = this.deps.createObjectURL(clause.blob);
            element.src = url;
        }
        element.volume = options.step ? STEP_VOLUME : 1;
        let settle: () => void = () => undefined;
        const ended = new Promise<void>((resolve) => (settle = resolve));
        let stopped = false;
        const finish = () => {
            element.removeEventListener("ended", finish);
            element.removeEventListener("error", finish);
            this.deps.revokeObjectURL(url);
            if (!stopped) settle();
        };
        element.addEventListener("ended", finish);
        element.addEventListener("error", finish);
        try {
            void Promise.resolve(element.play()).catch(finish);
        } catch {
            finish();
        }
        return {
            ended,
            stop: () => {
                if (stopped) return 0;
                const fraction = element.duration > 0 && Number.isFinite(element.duration) ? element.currentTime / element.duration : 0;
                stopped = true;
                element.pause();
                element.removeAttribute("src");
                element.load();
                finish();
                return Math.min(1, Math.max(0, fraction));
            },
        };
    }

    private speak(text: string, step: boolean): ClausePlayback {
        const synth = this.deps.synth;
        if (!synth) return { ended: Promise.resolve(), stop: () => 1 };
        const utterance = this.deps.createUtterance(text);
        if (this.voiceURI) {
            const voice = synth.getVoices().find((candidate) => candidate.voiceURI === this.voiceURI);
            if (voice) utterance.voice = voice;
        }
        if (this.rate) utterance.rate = this.rate;
        utterance.volume = step ? STEP_VOLUME : 1;
        let spokenTo = 0;
        let stopped = false;
        let settle: () => void = () => undefined;
        const ended = new Promise<void>((resolve) => (settle = resolve));
        utterance.onboundary = (event) => {
            spokenTo = Math.max(spokenTo, event.charIndex);
        };
        utterance.onend = () => {
            if (!stopped) settle();
        };
        utterance.onerror = () => {
            if (!stopped) settle();
        };
        synth.speak(utterance);
        return {
            ended,
            stop: () => {
                stopped = true;
                synth.cancel();
                return text.length > 0 ? Math.min(1, spokenTo / text.length) : 0;
            },
        };
    }

    /** Stops whatever plays and forgets what was loaded ahead. */
    reset(): void {
        for (const element of this.elements) {
            element.pause();
            element.removeAttribute("src");
        }
        this.dropPreloaded();
        try {
            this.deps.synth?.cancel();
        } catch {
            // Nothing to cancel.
        }
    }

    private dropPreloaded(): void {
        if (!this.preloaded) return;
        this.deps.revokeObjectURL(this.preloaded.url);
        this.preloaded = null;
    }
}
