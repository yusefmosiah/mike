import { useEffect, useRef, useState } from "react";
import type { ChatDetailOut, ThreadAuthor } from "@/app/components/shared/types";
import { getChat } from "@/app/lib/mikeApi";

export const THREAD_GENERATING_POLL_MS = 3000;

/**
 * Who is generating in a shared thread (goals/mission-5-firm-thread-handoff.md).
 * The page seeds it from the chat read; while it is set the hook re-reads the
 * chat every few seconds and, once that turn is done, clears it and hands the
 * fresh read to `onFinished` so the page can show the colleague's prompt and
 * answer.
 *
 * A page that opens mid-turn also streams that turn live (the chat read's
 * `active_turn`); the notice stays up meanwhile, since the stream alone does
 * not say whose turn it is. While a stream is attached here
 * (`localTurnActive`) the transcript is the stream's, so the hand-over waits
 * for it to end and then re-reads.
 */
export function useThreadGenerating({
    chatId,
    localTurnActive,
    onFinished,
    intervalMs = THREAD_GENERATING_POLL_MS,
}: {
    chatId: string | null;
    localTurnActive: boolean;
    onFinished: (detail: ChatDetailOut) => void;
    intervalMs?: number;
}) {
    const [holder, setHolder] = useState<{
        chatId: string;
        person: ThreadAuthor;
    } | null>(null);
    const finished = useRef(onFinished);
    const streaming = useRef(localTurnActive);
    useEffect(() => {
        finished.current = onFinished;
        streaming.current = localTurnActive;
    }, [onFinished, localTurnActive]);

    // The turn ended while a stream here still owned the transcript.
    const [handOverFor, setHandOverFor] = useState<string | null>(null);
    useEffect(() => {
        if (!handOverFor || localTurnActive) return;
        let cancelled = false;
        getChat(handOverFor)
            .then((detail) => {
                if (!cancelled) finished.current(detail);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setHandOverFor(null);
            });
        return () => {
            cancelled = true;
        };
    }, [handOverFor, localTurnActive]);

    const person = holder && holder.chatId === chatId ? holder.person : null;
    const watching = !!person;

    useEffect(() => {
        if (!watching || !chatId) return;
        let cancelled = false;
        let inFlight = false;
        const timer = setInterval(() => {
            if (inFlight) return;
            inFlight = true;
            getChat(chatId)
                .then((detail) => {
                    if (cancelled) return;
                    if (detail.generating) {
                        setHolder({ chatId, person: detail.generating });
                        return;
                    }
                    setHolder(null);
                    if (streaming.current) setHandOverFor(chatId);
                    else finished.current(detail);
                })
                // A failed poll is retried on the next tick.
                .catch(() => {})
                .finally(() => {
                    inFlight = false;
                });
        }, intervalMs);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [watching, chatId, intervalMs]);

    return {
        generating: person,
        /** Seed from a chat read: its `generating`, for that chat. */
        setGenerating: (forChat: string, next: ThreadAuthor | null | undefined) =>
            setHolder(next ? { chatId: forChat, person: next } : null),
    };
}
