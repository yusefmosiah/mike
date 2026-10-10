"use client";

import { useState } from "react";
import { LIQUID_GLASS_TRANSLUCENT_CLASS } from "@/app/components/ui/liquid-surface";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { useCodeApprovals } from "@/app/hooks/useCodeApprovals";
import type { CodeApproval, CodeApprovalDecision } from "@/app/lib/mikeApi";

function memberName(approval: CodeApproval): string {
    return approval.guest_name || approval.guest_email || "A member of this thread";
}

/**
 * Shown to the person who started a shared thread, above the composer: a
 * member's message wants to run a command in their workstation. Allow it for
 * that message, allow that member for the rest of this thread, or refuse.
 * Members already allowed are listed with a way to withdraw it.
 */
export function CodeApprovalRequests({
    chatId,
    isHost,
    watching,
}: {
    chatId: string | null;
    isHost: boolean;
    watching: boolean;
}) {
    const { approvals, failed, decide, revoke } = useCodeApprovals({
        chatId,
        isHost,
        watching,
    });
    const [busy, setBusy] = useState<string | null>(null);
    const pending = approvals.filter((approval) => approval.status === "pending");
    const allowed = approvals.filter((approval) => approval.status === "thread");
    if (!pending.length && !allowed.length && !failed) return null;

    const answer = async (id: string, decision: CodeApprovalDecision) => {
        setBusy(`${id}:${decision}`);
        try {
            await decide(id, decision);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex flex-col gap-2 pb-2">
            {pending.map((approval) => (
                <section
                    key={approval.id}
                    aria-label={`Request from ${memberName(approval)}`}
                    className={`rounded-[18px] p-3 ${LIQUID_GLASS_TRANSLUCENT_CLASS}`}
                >
                    <p className="text-sm text-gray-800 [overflow-wrap:anywhere]">
                        {memberName(approval)}&rsquo;s message wants to run a
                        command in your workstation.
                    </p>
                    {approval.summary && (
                        <TextSlabUI className="mt-2 max-h-32 overflow-auto">
                            <pre className="whitespace-pre-wrap font-mono text-xs text-gray-700 [overflow-wrap:anywhere]">
                                {approval.summary}
                            </pre>
                        </TextSlabUI>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <PillButtonUI
                            type="button"
                            tone="black"
                            loading={busy === `${approval.id}:once`}
                            disabled={!!busy}
                            onClick={() => void answer(approval.id, "once")}
                        >
                            Allow once
                        </PillButtonUI>
                        <PillButtonUI
                            type="button"
                            tone="white"
                            loading={busy === `${approval.id}:thread`}
                            disabled={!!busy}
                            onClick={() => void answer(approval.id, "thread")}
                        >
                            Allow for this thread
                        </PillButtonUI>
                        <TextButtonUI
                            loading={busy === `${approval.id}:denied`}
                            disabled={!!busy}
                            onClick={() => void answer(approval.id, "denied")}
                        >
                            Don&rsquo;t allow
                        </TextButtonUI>
                    </div>
                </section>
            ))}
            {allowed.map((approval) => (
                <p
                    key={approval.id}
                    className="flex flex-wrap items-center gap-x-2 px-2 text-sm text-gray-600 [overflow-wrap:anywhere]"
                >
                    <span>
                        {memberName(approval)} can run code in your workstation
                        in this thread.
                    </span>
                    <TextButtonUI
                        disabled={busy === `revoke:${approval.guest_user_id}`}
                        onClick={async () => {
                            setBusy(`revoke:${approval.guest_user_id}`);
                            try {
                                await revoke(approval.guest_user_id);
                            } finally {
                                setBusy(null);
                            }
                        }}
                    >
                        Withdraw
                    </TextButtonUI>
                </p>
            ))}
            {failed && (
                <p role="alert" className="px-2 text-sm text-red-600">
                    Your answer could not be saved. Try again.
                </p>
            )}
        </div>
    );
}
