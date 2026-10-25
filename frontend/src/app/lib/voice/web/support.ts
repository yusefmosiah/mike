/**
 * Whether this browser can run voice mode at all, by cheap synchronous checks
 * only (docs/voice-web.md): the voice button keys off this on every render,
 * so it must not probe the GPU or load anything. The full, asynchronous probe
 * that picks how voice mode runs here is web/capabilities.ts, loaded only
 * when voice mode starts.
 */

interface WindowLike {
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } };
    AudioContext?: unknown;
    webkitAudioContext?: unknown;
    AudioWorkletNode?: unknown;
    WebAssembly?: unknown;
    Worker?: unknown;
    MessageChannel?: unknown;
}

const currentWindow = (): WindowLike | undefined =>
    typeof window === "undefined" ? undefined : (window as unknown as WindowLike);

/**
 * A secure page with a microphone API, an AudioWorklet, WebAssembly and
 * workers: everything voice mode needs before any model is considered.
 */
export function webVoiceSupported(win: WindowLike | undefined = currentWindow()): boolean {
    if (!win || win.isSecureContext !== true) return false;
    return (
        typeof win.navigator?.mediaDevices?.getUserMedia === "function" &&
        (typeof win.AudioContext === "function" || typeof win.webkitAudioContext === "function") &&
        typeof win.AudioWorkletNode === "function" &&
        typeof win.WebAssembly === "object" &&
        typeof win.Worker === "function" &&
        typeof win.MessageChannel === "function"
    );
}
