"use client";

/**
 * One place that turns the user's voice preferences into a call: dictation
 * text from a recording, and audio for one sentence of read-aloud. The
 * browser's built-in engines do not fit this shape (they capture and play
 * themselves) and are driven directly by the hooks.
 */

import { synthesizeSpeech, transcribeAudio } from "@/app/lib/mikeApi";
import {
    FLUID_MINI_ENGINE,
    PHONON_ENGINE,
    fluidSpeechMiniAvailable,
    phononAvailable,
    isEnglishLanguage,
    speakOnDevice,
    transcribeOnDevice,
} from "./deviceSpeech";
import { isPhononVoice } from "./browserModels.spec";
import { looksEnglish } from "./englishText";
import { currentDictationVocabulary, loadUserVocabulary, recognizerTerms } from "./dictationVocabulary";
import { loadVoicePreferences, type VoicePreferences } from "./preferences";
import { correctWithVocabulary, type DictationVocabulary } from "./vocabulary";

/**
 * Dictation on the phone: Fluid Speech Mini when the app has it, the choice
 * (`model`) is not Apple's and the language is English (the model is English
 * only); otherwise Apple's recognizer. If Fluid Speech Mini fails, Apple's
 * takes the recording; when that fails too, the first error is the one shown.
 */
async function transcribeOnPhone(
    blob: Blob,
    preferences: VoicePreferences["transcription"],
    vocabulary: DictationVocabulary,
): Promise<string> {
    // Apple's recognizer is told the terms; the extra argument is left out
    // when there are none.
    const terms = recognizerTerms(vocabulary);
    const withApple = () =>
        terms.length > 0
            ? transcribeOnDevice(blob, preferences.language, undefined, terms)
            : transcribeOnDevice(blob, preferences.language);
    const wantsFluid = preferences.model !== "apple" && isEnglishLanguage(preferences.language);
    if (!wantsFluid || !(await fluidSpeechMiniAvailable())) {
        return withApple();
    }
    try {
        return await transcribeOnDevice(blob, preferences.language, FLUID_MINI_ENGINE);
    } catch (error) {
        try {
            return await withApple();
        } catch {
            throw error;
        }
    }
}

/** The vocabulary for this dictation: the person's list (fetched if need be) and the page's names. */
async function dictationVocabulary(): Promise<DictationVocabulary> {
    // A list that cannot be loaded (offline, signed out) is the same as none.
    await loadUserVocabulary().catch(() => undefined);
    return currentDictationVocabulary();
}

async function recognise(
    blob: Blob,
    preferences: VoicePreferences["transcription"],
    vocabulary: DictationVocabulary,
): Promise<string> {
    if (preferences.engine === "device") {
        return transcribeOnPhone(blob, preferences, vocabulary);
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
 * Dictation text from a recording, with the person's vocabulary applied to
 * whatever engine heard it.
 */
export async function transcribeRecording(
    blob: Blob,
    preferences: VoicePreferences["transcription"] = loadVoicePreferences().transcription,
    vocabulary?: DictationVocabulary,
): Promise<string> {
    const terms = vocabulary ?? (await dictationVocabulary());
    return correctWithVocabulary(await recognise(blob, preferences, terms), terms);
}

/** Applies the vocabulary to text an engine produced itself (the browser's own recognition). */
export async function correctDictation(text: string): Promise<string> {
    return correctWithVocabulary(text, await dictationVocabulary());
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
    if (preferences.engine === "webgpu") return { maxChars: 300, concurrency: 1 };
    // The phone renders one utterance at a time.
    if (preferences.engine === "device") return { maxChars: 1200, concurrency: 1 };
    return { maxChars: 1200, concurrency: 3 };
}

/**
 * Read-aloud on the phone: Phonon when the choice (`model`) is not Apple's,
 * the chosen voice (if any) is a Phonon voice, the text is English and the app
 * has downloaded the model; otherwise Apple's voices. If Phonon fails, Apple's
 * voice reads the sentence instead.
 */
async function speakOnPhone(text: string, preferences: VoicePreferences["speech"]): Promise<Blob> {
    // A Phonon voice name means nothing to Apple's synthesizer.
    const appleVoice = isPhononVoice(preferences.voice) ? undefined : preferences.voice;
    const wantsPhonon =
        preferences.model !== "apple" && (!preferences.voice || isPhononVoice(preferences.voice)) && looksEnglish(text);
    if (wantsPhonon && (await phononAvailable())) {
        try {
            return await speakOnDevice(text, preferences.voice, PHONON_ENGINE);
        } catch {
            // Apple's voice below reads it.
        }
    }
    return speakOnDevice(text, appleVoice);
}

export async function synthesizeSentence(
    text: string,
    preferences: VoicePreferences["speech"] = loadVoicePreferences().speech,
): Promise<Blob> {
    if (preferences.engine === "device") return speakOnPhone(text, preferences);
    if (preferences.engine === "webgpu") {
        const { speakWithBrowserModel } = await import("./browserModels");
        return speakWithBrowserModel(text, { voice: preferences.voice, model: preferences.model });
    }
    if (preferences.engine === "openrouter") {
        return synthesizeSpeech(text, { provider: "openrouter", model: preferences.model, voice: preferences.voice });
    }
    return synthesizeSpeech(text);
}
