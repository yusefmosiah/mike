"use client";

import { useSyncExternalStore } from "react";

/** A device whose main pointer is a finger: phones, tablets, the iPhone app. */
export const TOUCH_PRIMARY_QUERY = "(hover: none) and (pointer: coarse)";

const canMatch = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribe(onStoreChange: () => void) {
    if (!canMatch()) return () => {};
    const query = window.matchMedia(TOUCH_PRIMARY_QUERY);
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
}

function getSnapshot() {
    if (!canMatch()) return false;
    return window.matchMedia(TOUCH_PRIMARY_QUERY).matches;
}

function getServerSnapshot() {
    return false;
}

/**
 * Live match for a touch-first device. SSR, first paint and jsdom report a
 * mouse, so hover controls render until the page knows otherwise.
 */
export function useIsTouchPrimary() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
