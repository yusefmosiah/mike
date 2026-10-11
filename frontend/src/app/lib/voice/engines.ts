"use client";

/**
 * One place that turns the user's voice preferences into a call: dictation
 * text from a recording, and audio for one sentence of read-aloud. The
 * browser's built-in engines do not fit this shape (they capture and play
 * themselves) and are driven directly by the hooks.
 */

import { synthesizeSpeech, transcribeAudio } from "@/app/lib/mikeApi";
import { transcribeOnDevice } from "./deviceSpeech";
import { loadVoicePreferences, type VoicePreferences } from "./preferences";

export async function transcribeRecording(
    blob: Blob,
    preferences: VoicePreferences["transcription"] = loadVoicePreferences().transcription,
): Promise<string> {
    if (preferences.engine === "device") {
        return transcribeOnDevice(blob, preferences.language);
    }
    if (preferences.engine === "webgpu") {
        const { transcribeInBrowser } = await import("./browserModels");
        return transcribeInBrowser(blob);
    }
    const { text } = await transcribeAudio(
        blob,
        preferences.engine === "openrouter"
            ? { provider: "openrouter", model: preferences.model, language: preferences.language }
            : { language: preferences.language },
    );
    return text;
}

/**
 * How read-aloud renders a response with this engine: the longest text sent
 * in one synthesis call (the server takes up to 4,000 characters; Kokoro
 * reads a few sentences well at a time) and how many calls run at once (the
 * model in the browser runs one at a time).
 */
export function speechRenderPlan(
    preferences: VoicePreferences["speech"] = loadVoicePreferences().speech,
): { maxChars: number; concurrency: number } {
    return preferences.engine === "webgpu" ? { maxChars: 300, concurrency: 1 } : { maxChars: 1200, concurrency: 3 };
}

export async function synthesizeSentence(
    text: string,
    preferences: VoicePreferences["speech"] = loadVoicePreferences().speech,
): Promise<Blob> {
    if (preferences.engine === "webgpu") {
        const { speakWithBrowserModel } = await import("./browserModels");
        return speakWithBrowserModel(text, { voice: preferences.voice });
    }
    if (preferences.engine === "openrouter") {
        return synthesizeSpeech(text, { provider: "openrouter", model: preferences.model, voice: preferences.voice });
    }
    return synthesizeSpeech(text);
}
