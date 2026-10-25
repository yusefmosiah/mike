import { brand } from "@/app/lib/brand";
import { browserModelRuntime } from "./browserModels";
import { loadVoicePreferences, saveVoicePreferences } from "./preferences";
import { backend } from "./voiceEngine";

/**
 * Voice mode in a phone's browser works, but the app is the better place for
 * it. The voice button stays, and its first tap offers the app (VoiceAppModal)
 * before voice mode in the browser. The app itself never sees this.
 */

/** An iPhone or iPad browser, or an Android phone's. */
export function phoneBrowser(agent: string | undefined = typeof navigator === "undefined" ? undefined : navigator.userAgent): boolean {
    return browserModelRuntime().oneModelAtATime || /iPhone|iPod|Android.+Mobile|Mobile.+Android/.test(agent ?? "");
}

/**
 * Whether the voice button should offer the app first: in a phone browser
 * (not the app, whose own voice mode is untouched, and not a computer's
 * browser), until the person has chosen to use voice mode in the browser.
 */
export function phoneAppPromptNeeded(): boolean {
    if (backend() !== "web" || !phoneBrowser()) return false;
    return loadVoicePreferences().voiceMode?.phoneBrowser !== true;
}

/** Remembers that voice mode is used in this browser, so the button goes straight to it. */
export function rememberPhoneBrowserChoice(): void {
    const preferences = loadVoicePreferences();
    saveVoicePreferences({ ...preferences, voiceMode: { ...preferences.voiceMode, phoneBrowser: true } });
}

/** Where to get the phone app, from the install's brand; null unless it is a web link. */
export function phoneAppUrl(raw: string | undefined = brand.appUrl): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}
