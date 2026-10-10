// Guests running code in a shared thread's workstation.
//
// A thread's code runs in the workstation of the person who started it (the
// host), so Python state and files stay in one place however many people
// write in the thread. When another member's message makes the assistant run
// a command there, the turn waits for the host: allow it once (for that
// message's turn), allow it for the rest of the thread, or refuse. An
// approval names its chat and never reaches another thread.
// (migrations/20261010_09_chat_code_approvals.sql)
import type { Db } from "../../lib/db";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { GuestCodeApproval } from "./engine/streaming";

export type CodeApprovalStatus = "pending" | "once" | "thread" | "denied" | "expired" | "revoked";
export type CodeApprovalDecision = "once" | "thread" | "denied";
/** How a wait ends: the host's decision, or "expired" when they did not answer. */
export type CodeApprovalOutcome = CodeApprovalDecision | "expired";

/** How long a guest's turn waits for the host before it gives up. */
export const CODE_APPROVAL_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;
const MAX_SUMMARY_CHARS = 2_000;

type Row = {
    id: string;
    chat_id: string;
    host_user_id: string;
    guest_user_id: string;
    summary: string;
    status: CodeApprovalStatus;
    created_at: string;
};

/**
 * The person whose workstation a thread's code runs in: whoever started it.
 * A thread whose starter's account is gone has no workstation.
 */
export function workstationHostOf(chat: { user_id: string | null }): string | null {
    return chat.user_id ?? null;
}

/** Whether the host has allowed this guest's commands for the rest of the thread. */
export async function hasThreadCodeApproval(db: Db, chatId: string, guestUserId: string): Promise<boolean> {
    const { data, error } = await db
        .from("chat_code_approvals")
        .select("id")
        .eq("chat_id", chatId)
        .eq("guest_user_id", guestUserId)
        .eq("status", "thread")
        .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Asks the host to allow a guest's command and waits for the answer. A
 * cancelled turn withdraws the request (it is marked expired); so does a
 * host who does not answer within `timeoutMs`.
 */
export async function requestCodeApproval(
    db: Db,
    args: {
        chatId: string;
        hostUserId: string;
        guestUserId: string;
        summary: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        pollMs?: number;
    },
): Promise<CodeApprovalOutcome> {
    // A thread approval granted while this turn was running counts at once.
    if (await hasThreadCodeApproval(db, args.chatId, args.guestUserId)) return "thread";
    const { data, error } = await db
        .from("chat_code_approvals")
        .insert({
            chat_id: args.chatId,
            host_user_id: args.hostUserId,
            guest_user_id: args.guestUserId,
            summary: args.summary.slice(0, MAX_SUMMARY_CHARS),
        })
        .select("id")
        .single();
    if (error || !data) throw error ?? new Error("could not record the approval request");
    const id = (data as { id: string }).id;
    const deadline = Date.now() + (args.timeoutMs ?? CODE_APPROVAL_WAIT_MS);
    try {
        while (Date.now() < deadline) {
            await sleep(Math.min(args.pollMs ?? POLL_MS, Math.max(0, deadline - Date.now())), args.signal);
            const { data: row, error: readError } = await db
                .from("chat_code_approvals")
                .select("status")
                .eq("id", id)
                .maybeSingle();
            if (readError) throw readError;
            const status = (row as { status?: CodeApprovalStatus } | null)?.status;
            if (status === "once" || status === "thread" || status === "denied") return status;
            if (status !== "pending") return "expired";
        }
        return "expired";
    } finally {
        await db
            .from("chat_code_approvals")
            .update({ status: "expired", decided_at: new Date().toISOString() })
            .eq("id", id)
            .eq("status", "pending");
    }
}

export type CodeApprovalView = {
    id: string;
    guest_user_id: string;
    guest_name: string | null;
    guest_email: string | null;
    summary: string;
    status: CodeApprovalStatus;
    created_at: string;
};

/**
 * What the host of a thread sees: requests waiting for them, and the guests
 * they have allowed for the rest of the thread. Anyone else sees nothing.
 */
export async function codeApprovalsForViewer(
    db: Db,
    chatId: string,
    viewerId: string,
): Promise<CodeApprovalView[]> {
    try {
        const { data, error } = await db
            .from("chat_code_approvals")
            .select("id, chat_id, host_user_id, guest_user_id, summary, status, created_at")
            .eq("chat_id", chatId)
            .eq("host_user_id", viewerId)
            .in("status", ["pending", "thread"])
            .order("created_at", { ascending: true });
        if (error) throw error;
        const rows = (Array.isArray(data) ? data : []) as Row[];
        if (!rows.length) return [];
        const guests = [...new Set(rows.map((row) => row.guest_user_id))];
        const { data: profiles } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("user_id", guests);
        const people = new Map(
            ((Array.isArray(profiles) ? profiles : []) as Array<{ user_id: string; email: string | null; display_name: string | null }>)
                .map((p) => [p.user_id, p]),
        );
        return rows.map((row) => ({
            id: row.id,
            guest_user_id: row.guest_user_id,
            guest_name: people.get(row.guest_user_id)?.display_name?.trim() || null,
            guest_email: people.get(row.guest_user_id)?.email ?? null,
            summary: row.summary,
            status: row.status,
            created_at: row.created_at,
        }));
    } catch {
        // Informational on a chat read: the transcript still renders.
        return [];
    }
}

/** The host answers a waiting request. Only the host named on it can. */
export async function decideCodeApproval(
    db: Db,
    args: { chatId: string; requestId: string; hostUserId: string; decision: CodeApprovalDecision },
): Promise<ServiceResult<{ status: CodeApprovalDecision }>> {
    const { data, error } = await db
        .from("chat_code_approvals")
        .update({ status: args.decision, decided_at: new Date().toISOString() })
        .eq("id", args.requestId)
        .eq("chat_id", args.chatId)
        .eq("host_user_id", args.hostUserId)
        .eq("status", "pending")
        .select("id");
    if (error) return internalFailure(error);
    if (!Array.isArray(data) || !data.length) {
        return failure("conflict", "This request has already been answered or has expired.", "approval_closed");
    }
    return ok({ status: args.decision });
}

/** The host withdraws a guest's approval for the rest of the thread. */
export async function revokeThreadCodeApproval(
    db: Db,
    args: { chatId: string; hostUserId: string; guestUserId: string },
): Promise<ServiceResult<{ revoked: number }>> {
    const { data, error } = await db
        .from("chat_code_approvals")
        .update({ status: "revoked", decided_at: new Date().toISOString() })
        .eq("chat_id", args.chatId)
        .eq("host_user_id", args.hostUserId)
        .eq("guest_user_id", args.guestUserId)
        .eq("status", "thread")
        .select("id");
    if (error) return internalFailure(error);
    return ok({ revoked: Array.isArray(data) ? data.length : 0 });
}

/**
 * What a turn needs to let a guest ask the host: the host's name, whether
 * the host already allowed this guest for the thread, and the request
 * itself. Null when the sender is the host or the thread has none.
 */
export async function guestCodeApprovalFor(
    db: Db,
    args: { chatId: string | null; hostUserId: string | null; guestUserId: string },
): Promise<GuestCodeApproval | null> {
    const { chatId, hostUserId, guestUserId } = args;
    if (!chatId || !hostUserId || hostUserId === guestUserId) return null;
    let standing = false;
    let hostName: string | null = null;
    try {
        standing = await hasThreadCodeApproval(db, chatId, guestUserId);
        const { data } = await db
            .from("user_profiles")
            .select("email, display_name")
            .eq("user_id", hostUserId)
            .maybeSingle();
        const profile = data as { email: string | null; display_name: string | null } | null;
        hostName = profile?.display_name?.trim() || profile?.email || null;
    } catch {
        // Without the standing approval the guest is simply asked again.
    }
    return {
        hostName,
        standing,
        request: (summary, signal) =>
            requestCodeApproval(db, { chatId, hostUserId, guestUserId, summary, signal }),
    };
}
