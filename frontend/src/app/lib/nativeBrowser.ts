// Live web pages inside Mike's native app (iPhone, and the Mac build of the
// same shell). The shell's `Browser` plugin (@capacitor/browser) shows a page
// in the system's in-app Safari view, so a cited source or a chat link opens
// without leaving Mike. A browser has no bridge: the helpers say so and the
// caller falls back to its ordinary link behavior.

interface CapacitorBridge {
    PluginHeaders?: { name: string; methods?: { name: string }[] }[];
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "Browser";

function bridge(): NonNullable<CapacitorBridge["nativePromise"]> | null {
    // globalThis, not window: the server render has no window, and no bridge.
    const cap = (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
    if (typeof cap?.nativePromise !== "function") return null;
    const header = cap.PluginHeaders?.find((entry) => entry.name === PLUGIN);
    if (!header?.methods?.some((method) => method.name === "open")) return null;
    return cap.nativePromise.bind(cap);
}

/** True inside Mike's native app, whose shell can show a page in Safari's view. */
export function nativeBrowserSupported(): boolean {
    return bridge() !== null;
}

/** The URL, when it is an http(s) address; anything else is never opened. */
function webAddress(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
        return null;
    }
}

/**
 * Show the page in the in-app Safari view. False when there is no native
 * shell, the address is not http(s), or the view could not open; the caller
 * then opens the link the ordinary way.
 */
export async function openInNativeBrowser(url: string): Promise<boolean> {
    const call = bridge();
    const href = webAddress(url);
    if (!call || !href) return false;
    try {
        await call(PLUGIN, "open", { url: href });
        return true;
    } catch {
        return false;
    }
}
