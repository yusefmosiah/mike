import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_PREFERENCES_KEY, loadVoicePreferences } from "./preferences";

const engine = vi.hoisted(() => ({ backend: "web" as "web" | "native" | null }));
vi.mock("./voiceEngine", () => ({ backend: () => engine.backend }));

import { phoneAppPromptNeeded, phoneAppUrl, phoneBrowser, rememberPhoneBrowserChoice } from "./phoneApp";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function agent(value: string, touchPoints = 0) {
    Object.defineProperty(navigator, "userAgent", { value, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: touchPoints, configurable: true });
}

beforeEach(() => {
    engine.backend = "web";
    window.localStorage.clear();
});
afterEach(() => agent(MAC));

describe("phoneBrowser", () => {
    it("is true for iPhone and Android phone browsers, false for computers and Android tablets", () => {
        agent(IPHONE);
        expect(phoneBrowser()).toBe(true);
        agent(ANDROID);
        expect(phoneBrowser()).toBe(true);
        agent(MAC);
        expect(phoneBrowser()).toBe(false);
        expect(phoneBrowser(ANDROID.replace(" Mobile", ""))).toBe(false);
        expect(phoneBrowser(undefined)).toBe(false);
    });
});

describe("phoneAppPromptNeeded", () => {
    it("is true in a phone browser until the browser path has been chosen", () => {
        agent(IPHONE);
        expect(phoneAppPromptNeeded()).toBe(true);
        rememberPhoneBrowserChoice();
        expect(phoneAppPromptNeeded()).toBe(false);
        expect(loadVoicePreferences().voiceMode?.phoneBrowser).toBe(true);
        expect(JSON.parse(window.localStorage.getItem(VOICE_PREFERENCES_KEY)!).voiceMode.phoneBrowser).toBe(true);
    });

    it("keeps other voice mode choices when remembering", () => {
        agent(ANDROID);
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ voiceMode: { serverSpeech: true } }));
        rememberPhoneBrowserChoice();
        expect(loadVoicePreferences().voiceMode).toEqual({ serverSpeech: true, phoneBrowser: true });
    });

    it("is false in the native app and where voice mode is not offered", () => {
        agent(IPHONE);
        engine.backend = "native";
        expect(phoneAppPromptNeeded()).toBe(false);
        engine.backend = null;
        expect(phoneAppPromptNeeded()).toBe(false);
    });

    it("is false in a computer's browser", () => {
        agent(MAC);
        expect(phoneAppPromptNeeded()).toBe(false);
    });
});

describe("phoneAppUrl", () => {
    it("accepts only web links, and is null when unset", () => {
        expect(phoneAppUrl("https://apps.example/get")).toBe("https://apps.example/get");
        expect(phoneAppUrl("http://apps.example/")).toBe("http://apps.example/");
        expect(phoneAppUrl("javascript:alert(1)")).toBeNull();
        expect(phoneAppUrl("not a url")).toBeNull();
        expect(phoneAppUrl("")).toBeNull();
        expect(phoneAppUrl(undefined)).toBeNull();
    });

    it("reads the brand by default (no link in the stock install)", () => {
        expect(phoneAppUrl()).toBeNull();
    });
});
