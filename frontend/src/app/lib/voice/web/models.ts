/**
 * Voice mode's own files in the browser (docs/voice-web.md, "Models, privacy"):
 * Silero VAD v5 (MIT, about 2 MB), downloaded once after the person agrees,
 * from a pinned Hugging Face revision, checked against its SHA-256 and kept in
 * Cache Storage. ONNX Runtime and the capture worklet are served by the app
 * (public/voice-web/). Whisper and Phonon are fetched and cached by
 * browserModels.ts, with its own consent.
 */

export const SILERO_REPO = "onnx-community/silero-vad";
export const SILERO_REVISION = "e71cae966052b992a7eca6b17738916ce0eca4ec";
export const SILERO_FILE = "onnx/model.onnx";
export const SILERO_SHA256 = "a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808";
export const SILERO_URL = `https://huggingface.co/${SILERO_REPO}/resolve/${SILERO_REVISION}/${SILERO_FILE}`;

/** ONNX Runtime's plain WebAssembly build, copied by frontend/scripts/copy-voice-web.mjs. */
export const ORT_URL = "/voice-web/ort/ort.wasm.min.mjs";
export const CAPTURE_WORKLET_URL = "/voice-web/capture-worklet.js";

export const VOICE_CACHE = "mike-voice-web-v1";

export class VoiceModelError extends Error {}

interface CacheLike {
    match(url: string): Promise<Response | undefined>;
    put(url: string, response: Response): Promise<void>;
}

export interface ModelDeps {
    fetch?: typeof fetch;
    openCache?: () => Promise<CacheLike | null>;
    deleteCache?: () => Promise<unknown>;
    digest?: (bytes: ArrayBuffer) => Promise<string>;
}

const openCache = async (): Promise<CacheLike | null> => {
    try {
        return typeof caches === "undefined" ? null : await caches.open(VOICE_CACHE);
    } catch {
        // Cache Storage can be blocked (private windows, storage policy).
        return null;
    }
};

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Without Cache Storage the model lives here until the page reloads. */
let inMemory: ArrayBuffer | null = null;

/** Whether Silero is already in this browser. */
export async function sileroCached(deps: ModelDeps = {}): Promise<boolean> {
    if (inMemory) return true;
    const cache = await (deps.openCache ?? openCache)();
    return !!(await cache?.match(SILERO_URL).catch(() => undefined));
}

/** Downloads Silero (call after the person agreed), checks it and keeps it. */
export async function downloadSilero(onProgress?: (fraction: number) => void, deps: ModelDeps = {}): Promise<ArrayBuffer> {
    const response = await (deps.fetch ?? fetch)(SILERO_URL);
    if (!response.ok) throw new VoiceModelError("download failed");
    const total = Number(response.headers.get("content-length")) || 0;
    let bytes: ArrayBuffer;
    if (response.body && total > 0) {
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            loaded += value.length;
            onProgress?.(Math.min(1, loaded / total));
        }
        const joined = new Uint8Array(loaded);
        let at = 0;
        for (const part of parts) {
            joined.set(part, at);
            at += part.length;
        }
        bytes = joined.buffer;
    } else {
        bytes = await response.arrayBuffer();
    }
    if ((await (deps.digest ?? sha256Hex)(bytes)) !== SILERO_SHA256) throw new VoiceModelError("checksum mismatch");
    onProgress?.(1);
    const cache = await (deps.openCache ?? openCache)();
    if (cache) {
        await cache
            .put(SILERO_URL, new Response(bytes.slice(0), { headers: { "Content-Type": "application/octet-stream" } }))
            .catch(() => undefined);
    } else {
        inMemory = bytes;
    }
    return bytes;
}

/** Silero from the cache, checked again; rejects when it is not here. */
export async function loadSilero(deps: ModelDeps = {}): Promise<ArrayBuffer> {
    if (inMemory) return inMemory.slice(0);
    const cache = await (deps.openCache ?? openCache)();
    const cached = await cache?.match(SILERO_URL).catch(() => undefined);
    if (!cached) throw new VoiceModelError("not downloaded");
    const bytes = await cached.arrayBuffer();
    if ((await (deps.digest ?? sha256Hex)(bytes)) !== SILERO_SHA256) throw new VoiceModelError("checksum mismatch");
    return bytes;
}

/** Deletes voice mode's own downloads (Whisper and Phonon have their own removal). */
export async function removeVoiceModels(deps: ModelDeps = {}): Promise<void> {
    inMemory = null;
    await (deps.deleteCache ?? (() => (typeof caches === "undefined" ? Promise.resolve(false) : caches.delete(VOICE_CACHE))))().catch(
        () => undefined,
    );
}

/** Asks the browser to keep the downloads under storage pressure. Never rejects. */
export async function requestPersistentStorage(): Promise<void> {
    try {
        await navigator.storage?.persist?.();
    } catch {
        // Not granted: the browser may evict the models, and they download again.
    }
}

/** Bytes per second for the "about N minutes" estimate, without downloading anything. */
export function estimatedBytesPerSecond(nav: { connection?: { downlink?: number } } | undefined = typeof navigator === "undefined" ? undefined : (navigator as never)): number {
    const megabits = nav?.connection?.downlink;
    // `downlink` is in megabits per second (Chrome caps it at 10); without it, assume 10.
    return typeof megabits === "number" && megabits > 0 ? megabits * 125_000 : 1_250_000;
}
