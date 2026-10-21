// Renamed/retired model ids → their current equivalents. Stored preferences
// and localStorage selections outlive catalog renames; mapping here keeps an
// old saved value working instead of silently kicking it to the fallback.
// Its own module so the registry (which models.ts imports) can read it too.
export const LEGACY_MODEL_IDS: Record<string, string> = {
    "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
    "gpt-5.4-lite": "gpt-5.4-mini",
    // The River selection replaced DeepSeek V4.1 Flash with its 1017 release
    // (docs/configured-models.md).
    "river/deepseek-v4.1-flash": "river/deepseek-v4.1-flash-1017",
};
