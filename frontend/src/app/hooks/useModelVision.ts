"use client";

import { useEffect, useState } from "react";
import { getModelsVision } from "../lib/mikeApi";

/**
 * Whether each model can see images, asked of the backend once per model per
 * page load. The answer comes from the catalog entry a turn would use, so the
 * picker, the composer and the turn agree. Unanswered ids are absent: callers
 * treat "not known yet" as neither yes nor no.
 */
const answers = new Map<string, boolean>();
const pending = new Map<string, Promise<void>>();

export function useModelVision(ids: readonly string[]): Readonly<Record<string, boolean>> {
    const key = [...new Set(ids)].sort().join("\n");
    const [, setVersion] = useState(0);

    useEffect(() => {
        const wanted = key ? key.split("\n") : [];
        const missing = wanted.filter((id) => !answers.has(id) && !pending.has(id));
        const inFlight = wanted.flatMap((id) => pending.get(id) ?? []);
        let live = true;
        const refresh = () => {
            if (live) setVersion((version) => version + 1);
        };
        if (missing.length) {
            const lookup = Promise.resolve()
                .then(() => getModelsVision(missing))
                .then((vision) => {
                    for (const id of missing) answers.set(id, vision[id] === true);
                })
                // Unknown stays unknown; the backend still refuses at send.
                .catch(() => undefined)
                .finally(() => {
                    for (const id of missing) pending.delete(id);
                });
            for (const id of missing) pending.set(id, lookup);
            inFlight.push(lookup);
        }
        void Promise.all(inFlight).then(refresh);
        return () => {
            live = false;
        };
    }, [key]);

    const known: Record<string, boolean> = {};
    for (const id of key ? key.split("\n") : []) {
        const answer = answers.get(id);
        if (answer !== undefined) known[id] = answer;
    }
    return known;
}

export function resetModelVisionForTests(): void {
    answers.clear();
    pending.clear();
}
