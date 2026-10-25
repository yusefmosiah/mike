/** True or false is the person's choice; null follows the device. */
export type DarkModePreference = boolean | null;

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function applyDarkMode(enabled: boolean): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", enabled);
    document.documentElement.style.colorScheme = enabled ? "dark" : "light";
}

/**
 * Applies a preference, and while it follows the device, keeps following it
 * as the device switches. Returns the function that stops following.
 */
export function followDarkMode(preference: DarkModePreference): () => void {
    if (preference !== null) {
        applyDarkMode(preference);
        return () => {};
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        applyDarkMode(false);
        return () => {};
    }
    const query = window.matchMedia(SYSTEM_DARK);
    const apply = () => applyDarkMode(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
}
