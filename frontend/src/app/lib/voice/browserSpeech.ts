"use client";

/**
 * The browser's own speech engines (goals/mission-10-voice.md):
 *  - recognition through the Web Speech API, ONLY on device
 *    (`processLocally = true`); without it Chrome sends audio to Google, so
 *    a browser that cannot recognise locally is treated as unable to;
 *  - speech through `speechSynthesis` and the operating system's voices.
 * Nothing here records to disk or calls Mike's backend.
 */

type RecognitionStatus = "available" | "downloadable" | "downloading" | "unavailable";

interface RecognitionResultList {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
}

interface Recognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    processLocally?: boolean;
    onresult: ((event: { resultIndex: number; results: RecognitionResultList }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

interface RecognitionConstructor {
    new (): Recognition;
    available?: (options: { langs: string[]; processLocally: boolean }) => Promise<RecognitionStatus>;
    install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

function recognitionConstructor(): RecognitionConstructor | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function defaultSpeechLanguage(): string {
    return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/**
 * Whether this browser can recognise `lang` on device: "available" now,
 * "downloadable" after an install the user starts, or "unavailable" (no
 * on-device support at all, so the engine is not offered).
 */
export async function onDeviceRecognitionStatus(lang = defaultSpeechLanguage()): Promise<RecognitionStatus> {
    const Ctor = recognitionConstructor();
    if (!Ctor?.available) return "unavailable";
    try {
        return await Ctor.available({ langs: [lang], processLocally: true });
    } catch {
        return "unavailable";
    }
}

/** Downloads the language pack; call from a user's click. */
export async function installOnDeviceRecognition(lang = defaultSpeechLanguage()): Promise<boolean> {
    const Ctor = recognitionConstructor();
    if (!Ctor?.install) return false;
    try {
        return await Ctor.install({ langs: [lang], processLocally: true });
    } catch {
        return false;
    }
}

export interface OnDeviceRecognitionSession {
    /** Stops listening and resolves with everything recognised. */
    stop(): Promise<string>;
    /** Stops without a result. */
    cancel(): void;
}

export class BrowserRecognitionError extends Error {}

const RECOGNITION_ERROR_MESSAGES: Record<string, string> = {
    "not-allowed": "Microphone access denied",
    "service-not-allowed": "Microphone access denied",
    "language-not-supported": "On-device recognition is not installed for this language.",
    "audio-capture": "No microphone was found.",
};

/** Starts on-device recognition; rejects if the browser cannot do it locally. */
export function startOnDeviceRecognition(lang = defaultSpeechLanguage()): OnDeviceRecognitionSession {
    const Ctor = recognitionConstructor();
    if (!Ctor) throw new BrowserRecognitionError("On-device recognition is not available in this browser.");
    const recognition = new Ctor();
    if (!("processLocally" in recognition)) {
        throw new BrowserRecognitionError("On-device recognition is not available in this browser.");
    }
    recognition.processLocally = true;
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = false;
    const finals: string[] = [];
    let failure: string | null = null;
    let settle: ((text: string) => void) | null = null;
    let reject: ((error: Error) => void) | null = null;
    const ended = new Promise<string>((resolve, rejectEnded) => {
        settle = resolve;
        reject = rejectEnded;
    });
    recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) finals.push(result[0].transcript.trim());
        }
    };
    recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        failure = RECOGNITION_ERROR_MESSAGES[event.error] ?? "Could not recognise speech. Please try again.";
    };
    recognition.onend = () => {
        if (failure) reject?.(new BrowserRecognitionError(failure));
        else settle?.(finals.filter(Boolean).join(" "));
    };
    recognition.start();
    return {
        stop: () => {
            recognition.stop();
            return ended;
        },
        cancel: () => {
            settle = null;
            reject = null;
            recognition.abort();
        },
    };
}

export function browserSpeechSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * The operating system's voices. Chrome fills the list asynchronously, so
 * this waits briefly for `voiceschanged` when it starts empty.
 */
export async function browserVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
    if (!browserSpeechSupported()) return [];
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length > 0) return now;
    return new Promise((resolve) => {
        const done = () => {
            synth.removeEventListener("voiceschanged", done);
            clearTimeout(timer);
            resolve(synth.getVoices());
        };
        const timer = setTimeout(done, timeoutMs);
        synth.addEventListener("voiceschanged", done);
    });
}

/** Speaks one piece of text; resolves when it ends, rejects on an engine error. */
export function speakWithBrowser(
    text: string,
    options: { voiceURI?: string; rate?: number } = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!browserSpeechSupported()) {
            reject(new Error("This browser cannot read aloud."));
            return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        if (options.voiceURI) {
            const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === options.voiceURI);
            if (voice) utterance.voice = voice;
        }
        if (options.rate) utterance.rate = options.rate;
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
            // Cancelling (stop, or the next sentence) is not a failure.
            if (event.error === "canceled" || event.error === "interrupted") resolve();
            else reject(new Error("Playback failed."));
        };
        window.speechSynthesis.speak(utterance);
    });
}
