"use client";

import { useCallback, useEffect, useState } from "react";
import {
    decideCodeApproval,
    getCodeApprovals,
    revokeCodeApproval,
    type CodeApproval,
    type CodeApprovalDecision,
} from "@/app/lib/mikeApi";

export const CODE_APPROVAL_POLL_MS = 3000;

/**
 * For the person who started a shared thread: other members' requests to run
 * code in their workstation, and the members they allowed for the rest of the
 * thread (backend chat.codeApprovals.ts). Read when the thread opens and
 * every few seconds while a member's turn runs or a request waits.
 */
export function useCodeApprovals({
    chatId,
    isHost,
    watching,
    intervalMs = CODE_APPROVAL_POLL_MS,
}: {
    chatId: string | null;
    /** Only the thread's starter is ever asked; nobody else polls. */
    isHost: boolean;
    /** Someone else's turn is running in the thread. */
    watching: boolean;
    intervalMs?: number;
}) {
    // Keyed by chat, so another thread reads as empty until its own load.
    const [loaded, setLoaded] = useState<{
        chatId: string;
        approvals: CodeApproval[];
    } | null>(null);
    const [failed, setFailed] = useState(false);
    const enabled = !!chatId && isHost;
    const approvals =
        enabled && loaded && loaded.chatId === chatId ? loaded.approvals : [];
    const waiting = approvals.some((approval) => approval.status === "pending");

    // After an answer: read again so the request leaves and an approval
    // for the thread shows.
    const refresh = useCallback(async () => {
        if (!chatId) return;
        try {
            setLoaded({ chatId, approvals: await getCodeApprovals(chatId) });
        } catch {
            // The next poll or answer reads again.
        }
    }, [chatId]);

    // Read once when the thread opens, then poll only while something can
    // change. Kept apart so a request arriving (which starts the polling)
    // does not trigger an extra read of its own.
    const polling = watching || waiting;
    useEffect(() => {
        if (!enabled || !chatId) return;
        const controller = new AbortController();
        getCodeApprovals(chatId, controller.signal)
            .then((next) => {
                if (!controller.signal.aborted) setLoaded({ chatId, approvals: next });
            })
            .catch(() => {
                // The next poll or answer reads again.
            });
        return () => controller.abort();
    }, [enabled, chatId]);
    useEffect(() => {
        if (!enabled || !chatId || !polling) return;
        const controller = new AbortController();
        const timer = setInterval(() => {
            getCodeApprovals(chatId, controller.signal)
                .then((next) => {
                    if (!controller.signal.aborted) setLoaded({ chatId, approvals: next });
                })
                .catch(() => {
                    // A failed read is retried on the next tick.
                });
        }, intervalMs);
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [enabled, chatId, polling, intervalMs]);

    const decide = useCallback(
        async (requestId: string, decision: CodeApprovalDecision) => {
            if (!chatId) return;
            setFailed(false);
            try {
                await decideCodeApproval(chatId, requestId, decision);
            } catch {
                setFailed(true);
            }
            await refresh();
        },
        [chatId, refresh],
    );

    const revoke = useCallback(
        async (guestUserId: string) => {
            if (!chatId) return;
            setFailed(false);
            try {
                await revokeCodeApproval(chatId, guestUserId);
            } catch {
                setFailed(true);
            }
            await refresh();
        },
        [chatId, refresh],
    );

    return { approvals, failed, decide, revoke };
}
