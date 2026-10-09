"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Voice preferences (goals/mission-10-voice.md): which engine transcribes
 * dictation and which reads answers aloud, and with what model and voice.
 *
 * They are kept per device, in this browser, not on the account: the
 * browser's built-in voices and an on-device model exist on one machine and
 * not the next.
 *
 *  - "operator": the deployment's own speech server (the default).
 *  - "openrouter": OpenRouter, the comparison lane; never in strict private
 *    mode (the server refuses it there too).
 *  - "browser": the browser's own engine (on-device recognition, the
 *    operating system's voices).
 *  - "webgpu": an open model downloaded into this browser, after consent.
 */
export type VoiceEngine = "operator" | "openrouter" | "browser" | "webgpu";

export const VOICE_ENGINES: readonly VoiceEngine[] = [
    "operator",
    "openrouter",
    "browser",
    "webgpu",
];

export interface VoicePreferences {
    transcription: { engine: VoiceEngine; model?: string; language?: string };
    speech: { engine: VoiceEngine; model?: string; voice?: string };
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
    transcription: { engine: "operator" },
    speech: { engine: "operator" },
};

export const VOICE_PREFERENCES_KEY = "mike.voice.v1";
const CHANGE_EVENT = "mike:voice-preferences";

const isEngine = (value: unknown): value is VoiceEngine =>
    typeof value === "string" && (VOICE_ENGINES as readonly string[]).includes(value);

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

/** Anything malformed falls back to the defaults, field by field. */
export function parseVoicePreferences(raw: unknown): VoicePreferences {
    const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const t = (root.transcription && typeof root.transcription === "object" ? root.transcription : {}) as Record<string, unknown>;
    const s = (root.speech && typeof root.speech === "object" ? root.speech : {}) as Record<string, unknown>;
    return {
        transcription: {
            engine: isEngine(t.engine) ? t.engine : DEFAULT_VOICE_PREFERENCES.transcription.engine,
            ...(text(t.model) ? { model: text(t.model) } : {}),
            ...(text(t.language) ? { language: text(t.language) } : {}),
        },
        speech: {
            engine: isEngine(s.engine) ? s.engine : DEFAULT_VOICE_PREFERENCES.speech.engine,
            ...(text(s.model) ? { model: text(s.model) } : {}),
            ...(text(s.voice) ? { voice: text(s.voice) } : {}),
        },
    };
}

let cachedRaw: string | null | undefined;
let cachedValue: VoicePreferences = DEFAULT_VOICE_PREFERENCES;

export function loadVoicePreferences(): VoicePreferences {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(VOICE_PREFERENCES_KEY);
    } catch {
        // Storage blocked (private window, policy): the defaults apply.
    }
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    try {
        cachedValue = raw ? parseVoicePreferences(JSON.parse(raw)) : DEFAULT_VOICE_PREFERENCES;
    } catch {
        cachedValue = DEFAULT_VOICE_PREFERENCES;
    }
    return cachedValue;
}

export function saveVoicePreferences(preferences: VoicePreferences): void {
    try {
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify(parseVoicePreferences(preferences)));
    } catch {
        // Not persisted; this tab still sees the change through the event.
        cachedRaw = JSON.stringify(preferences);
        cachedValue = parseVoicePreferences(preferences);
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === VOICE_PREFERENCES_KEY) onChange();
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange);
        window.removeEventListener("storage", onStorage);
    };
}

/** The current preferences, updated across components and tabs. */
export function useVoicePreferences(): [VoicePreferences, (next: VoicePreferences) => void] {
    const value = useSyncExternalStore(subscribe, loadVoicePreferences, () => DEFAULT_VOICE_PREFERENCES);
    const set = useCallback((next: VoicePreferences) => saveVoicePreferences(next), []);
    return [value, set];
}

/** What this deployment and this browser can actually do. */
export interface VoiceAvailability {
    operatorTranscription: boolean;
    operatorSpeech: boolean;
    openRouter: boolean;
    browserRecognition: boolean;
    browserSpeech: boolean;
    webgpu: boolean;
}

export function engineAvailable(
    kind: "transcription" | "speech",
    engine: VoiceEngine,
    availability: VoiceAvailability,
): boolean {
    switch (engine) {
        case "operator":
            return kind === "transcription" ? availability.operatorTranscription : availability.operatorSpeech;
        case "openrouter":
            return availability.openRouter;
        case "browser":
            return kind === "transcription" ? availability.browserRecognition : availability.browserSpeech;
        case "webgpu":
            return availability.webgpu;
    }
}

/**
 * The engine a request will use: the chosen one when it is available here,
 * otherwise the first available of operator, browser, webgpu. OpenRouter is
 * never a fallback; it runs only when chosen and allowed.
 */
export function resolveVoiceEngine(
    kind: "transcription" | "speech",
    preferences: VoicePreferences,
    availability: VoiceAvailability,
): VoiceEngine | null {
    const chosen = preferences[kind].engine;
    if (engineAvailable(kind, chosen, availability)) return chosen;
    for (const engine of ["operator", "browser", "webgpu"] as const) {
        if (engineAvailable(kind, engine, availability)) return engine;
    }
    return null;
}
