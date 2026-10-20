"use client";

import { useEffect, useRef } from "react";
import type { LiveTranscript } from "@/app/lib/voice/engines";

/**
 * The text heard so far while the iPhone transcribes a dictation live:
 * confirmed words in the normal colour, the tail that may still change
 * muted. It wraps long text, has a maximum height and keeps the newest words
 * in view. Only the confirmed text is a polite live region, so a screen
 * reader is not read the tail every time it changes.
 */
export function LiveDictationText({ confirmed, volatile }: LiveTranscript) {
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [confirmed, volatile]);
    const listening = !confirmed && !volatile;
    return (
        <div
            ref={scrollRef}
            data-slot="live-dictation-text"
            className="mx-4 mt-3 max-h-28 overflow-y-auto rounded-lg bg-accent px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere]"
        >
            <span aria-live="polite" className="text-foreground">
                {confirmed}
            </span>
            {volatile ? (
                <span className="text-muted-foreground">
                    {confirmed ? " " : ""}
                    {volatile}
                </span>
            ) : null}
            {listening ? <span className="text-muted-foreground">Listening…</span> : null}
        </div>
    );
}
