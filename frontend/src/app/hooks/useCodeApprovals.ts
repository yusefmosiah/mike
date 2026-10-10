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

    useEffect(() => {
        if (!enabled || !chatId) return;
        const controller = new AbortController();
        const load = async () => {
            try {
                const next = await getCodeApprovals(chatId, controller.signal);
                if (!controller.signal.aborted) setLoaded({ chatId, approvals: next });
            } catch {
                // A failed read is retried on the next tick.
            }
        };
        void load();
        if (!watching && !waiting) return () => controller.abort();
        const timer = setInterval(() => void load(), intervalMs);
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [enabled, chatId, watching, waiting, intervalMs]);

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
