/**
 * Browsers start audio only from a tap, and voice mode's engine in the
 * browser is loaded after the tap (web/webBackend.ts, imported on demand).
 * So the voice button's tap runs this, synchronously and before anything is
 * awaited: it creates and resumes the AudioContext the microphone will use,
 * and plays a moment of silence on the two `<audio>` elements answers will
 * play through (and an empty utterance for the system's voice). The engine
 * takes them when it starts. Kept tiny: it is in the page's main bundle.
 */

import { SILENT_WAV } from "./silentWav";

export interface PrimedAudio {
    context: AudioContext | null;
    elements: HTMLAudioElement[];
}

let primed: PrimedAudio | null = null;

/** Call inside the person's tap. Never throws. */
export function primeWebAudio(): void {
    if (typeof window === "undefined") return;
    try {
        const Context =
            window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        let context = primed?.context ?? null;
        if (!context || context.state === "closed") context = Context ? new Context() : null;
        void context?.resume().catch(() => undefined);
        const elements = primed?.elements.length === 2 ? primed.elements : [new Audio(), new Audio()];
        for (const element of elements) {
            element.src = SILENT_WAV;
            void Promise.resolve(element.play()).catch(() => undefined);
        }
        // Headless Chromium under automation crashes the page on `speak`; a
        // browser driven by a test has no person to hear the system's voice.
        if ("speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" && !navigator.webdriver) {
            const utterance = new SpeechSynthesisUtterance("");
            utterance.volume = 0;
            window.speechSynthesis.speak(utterance);
        }
        primed = { context, elements };
    } catch {
        // Audio could not be unlocked; the engine tries again when it starts.
    }
}

/** What the last tap primed, handed to the engine once (later starts prime again). */
export function takePrimedAudio(): PrimedAudio | null {
    const taken = primed;
    primed = null;
    return taken;
}
