"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether hands-free voice mode is on anywhere on the page. While it is, the
 * engine owns the audio: read-aloud stops and its controls are hidden, so two
 * voices never speak at once.
 */

let active = false;
const listeners = new Set<(active: boolean) => void>();

export function voiceModeActive(): boolean {
    return active;
}

export function setVoiceModeActive(next: boolean): void {
    if (next === active) return;
    active = next;
    for (const listener of [...listeners]) listener(active);
}

/** Hears every change; returns the function that stops listening. */
export function subscribeVoiceMode(listener: (active: boolean) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useVoiceModeActive(): boolean {
    return useSyncExternalStore(subscribeVoiceMode, voiceModeActive, () => false);
}
