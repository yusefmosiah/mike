"use client";

/**
 * Which speaker model voice mode checks a voice with (docs/voice-chat.md,
 * "Other voices"). Both models run and are logged whichever decides; "both"
 * averages their margins over their own thresholds, and "off" checks and
 * learns nothing. Kept on this device, like the models.
 */
export type SpeakerModel = "wespeaker" | "campplus" | "both" | "off";

export const SPEAKER_MODELS: readonly SpeakerModel[] = ["wespeaker", "campplus", "both", "off"];
export const DEFAULT_SPEAKER_MODEL: SpeakerModel = "wespeaker";
export const SPEAKER_MODEL_KEY = "mike.voice.speakerModel.v1";

const isSpeakerModel = (value: unknown): value is SpeakerModel =>
    typeof value === "string" && (SPEAKER_MODELS as readonly string[]).includes(value);

export function loadSpeakerModel(): SpeakerModel {
    try {
        const value = window.localStorage.getItem(SPEAKER_MODEL_KEY);
        return isSpeakerModel(value) ? value : DEFAULT_SPEAKER_MODEL;
    } catch {
        return DEFAULT_SPEAKER_MODEL;
    }
}

export function saveSpeakerModel(model: SpeakerModel): void {
    try {
        if (model === DEFAULT_SPEAKER_MODEL) window.localStorage.removeItem(SPEAKER_MODEL_KEY);
        else window.localStorage.setItem(SPEAKER_MODEL_KEY, model);
    } catch {
        // Storage blocked: the choice lasts until the page reloads.
    }
}

/** The engine config for the stored choice; nothing for the default. */
export function speakerModelConfig(): { speakerModel?: SpeakerModel } {
    const model = loadSpeakerModel();
    return model === DEFAULT_SPEAKER_MODEL ? {} : { speakerModel: model };
}
