"use client";

import { useSyncExternalStore } from "react";

export const DESKTOP_QUERY = "(min-width: 768px)";

/** No `window` (server render) or no `matchMedia` (jsdom): report desktop. */
const canMatch = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribeToDesktopQuery(onStoreChange: () => void) {
    if (!canMatch()) return () => {};
    const query = window.matchMedia(DESKTOP_QUERY);
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
}

function getDesktopSnapshot() {
    if (!canMatch()) return true;
    return window.matchMedia(DESKTOP_QUERY).matches;
}

function getDesktopServerSnapshot() {
    return true;
}

/** Live `md:`-breakpoint match; SSR/first paint assumes desktop. */
export function useIsDesktop() {
    return useSyncExternalStore(
        subscribeToDesktopQuery,
        getDesktopSnapshot,
        getDesktopServerSnapshot,
    );
}
