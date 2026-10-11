"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getModelsVision } from "../lib/mikeApi";

/**
 * Whether each model can see images, asked of the backend once per model per
 * page load. The answer comes from the catalog entry a turn would use, so the
 * picker, the composer and the turn agree. Unanswered ids are absent: callers
 * treat "not known yet" as neither yes nor no.
 *
 * The answers are an immutable snapshot behind useSyncExternalStore, not a
 * mutable map read during render: the React Compiler memoizes on what render
 * reads, and would keep returning the empty first answer.
 */
let answers: Readonly<Record<string, boolean>> = {};
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const snapshot = () => answers;

function publish(next: Readonly<Record<string, boolean>>): void {
    answers = next;
    for (const listener of listeners) listener();
}

export function useModelVision(ids: readonly string[]): Readonly<Record<string, boolean>> {
    const key = [...new Set(ids)].sort().join("\n");
    const all = useSyncExternalStore(subscribe, snapshot, snapshot);

    useEffect(() => {
        const wanted = key ? key.split("\n") : [];
        const missing = wanted.filter((id) => !(id in answers) && !pending.has(id));
        if (!missing.length) return;
        const lookup = Promise.resolve()
            .then(() => getModelsVision(missing))
            .then((vision) => {
                const next = { ...answers };
                for (const id of missing) next[id] = vision[id] === true;
                publish(next);
            })
            // Unknown stays unknown; the backend still refuses at send.
            .catch(() => undefined)
            .finally(() => {
                for (const id of missing) pending.delete(id);
            });
        for (const id of missing) pending.set(id, lookup);
    }, [key]);

    const known: Record<string, boolean> = {};
    for (const id of key ? key.split("\n") : []) {
        if (id in all) known[id] = all[id]!;
    }
    return known;
}

export function resetModelVisionForTests(): void {
    pending.clear();
    publish({});
}
