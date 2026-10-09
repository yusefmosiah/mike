"use client";

/**
 * One place that turns the user's voice preferences into a call: dictation
 * text from a recording, and audio for one sentence of read-aloud. The
 * browser's built-in engines do not fit this shape (they capture and play
 * themselves) and are driven directly by the hooks.
 */

import { synthesizeSpeech, transcribeAudio } from "@/app/lib/mikeApi";
import { loadVoicePreferences, type VoicePreferences } from "./preferences";

export async function transcribeRecording(
    blob: Blob,
    preferences: VoicePreferences["transcription"] = loadVoicePreferences().transcription,
): Promise<string> {
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
