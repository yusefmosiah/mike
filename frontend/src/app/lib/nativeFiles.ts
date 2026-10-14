// Downloads inside Mike's iPhone app. The app's web view ignores a link that
// downloads a blob, so a file goes to the shell's `MikeFiles` plugin
// (mobile/plugins/files), which opens the share sheet: Save to Files,
// AirDrop, Mail. A browser has no bridge and downloads as usual.

interface CapacitorBridge {
    PluginHeaders?: { name: string }[];
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "MikeFiles";

/** The shell's bridge when it has the file plugin (app builds before it have none). */
function bridge(): NonNullable<CapacitorBridge["nativePromise"]> | null {
    // globalThis, not window: the server render has no window, and no bridge.
    const cap = (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
    if (typeof cap?.nativePromise !== "function") return null;
    if (!cap.PluginHeaders?.some((header) => header.name === PLUGIN)) return null;
    return cap.nativePromise.bind(cap);
}

/** True inside Mike's iPhone app, whose shell can save files. */
export function nativeFileSaveSupported(): boolean {
    return bridge() !== null;
}

async function base64Of(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * Hand the file to the iPhone's share sheet. False outside the app, where the
 * caller downloads it instead; closing the sheet without saving is not an error.
 */
export async function saveFileNatively(blob: Blob, filename: string): Promise<boolean> {
    const call = bridge();
    if (!call) return false;
    await call(PLUGIN, "share", {
        data: await base64Of(blob),
        filename,
        ...(blob.type ? { mimeType: blob.type } : {}),
    });
    return true;
}
