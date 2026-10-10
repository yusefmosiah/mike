"use client";

import { useState } from "react";
import type {
    CitationCheckVerdict,
    DocumentCitationCheck,
    DocumentCitationChecks,
} from "@/app/lib/mikeApi";
import { useDocumentCitationChecks } from "@/app/hooks/useDocumentCitationChecks";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

/** Most serious first; the order the flagged list is shown in. */
const SEVERITY: CitationCheckVerdict[] = [
    "contradicted",
    "not-found",
    "quote-mismatch",
    "unsupported",
    "unverifiable",
    "exists-and-matches",
];

export const VERDICT_LABEL: Record<CitationCheckVerdict, string> = {
    contradicted: "Says the opposite",
    "not-found": "Source not found",
    "quote-mismatch": "Quote not in source",
    unsupported: "Source does not say this",
    unverifiable: "Could not check",
    "exists-and-matches": "Verified",
};

const FLAGGED = new Set<CitationCheckVerdict>([
    "contradicted",
    "not-found",
    "quote-mismatch",
    "unsupported",
]);

const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

export function summarizeChecks(checks: DocumentCitationCheck[]): {
    flagged: DocumentCitationCheck[];
    verified: number;
    unverifiable: number;
} {
    const ordered = [...checks].sort(
        (a, b) =>
            SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict) ||
            a.citation_ref - b.citation_ref,
    );
    return {
        flagged: ordered.filter((check) => FLAGGED.has(check.verdict)),
        verified: checks.filter(
            (check) => check.verdict === "exists-and-matches",
        ).length,
        unverifiable: checks.filter((check) => check.verdict === "unverifiable")
            .length,
    };
}

function resultLine(
    data: DocumentCitationChecks,
    versionId: string | null | undefined,
) {
    const { flagged, verified, unverifiable } = summarizeChecks(data.checks);
    const unchanged =
        !!versionId &&
        !!data.task?.document_version_id &&
        data.task.document_version_id !== versionId &&
        data.task.document_version_id !== data.current_version_id;
    const lead = unchanged
        ? "Citations unchanged since the last check"
        : "Citations checked";
    const parts: string[] = [];
    if (flagged.length)
        parts.push(`${flagged.length} of ${data.checks.length} need attention`);
    else if (verified) parts.push(`${plural(verified, "citation")} verified`);
    if (unverifiable) parts.push(`${unverifiable} could not be checked`);
    if (!data.checks.length) parts.push("none found");
    return { lead, detail: parts.join(" · "), flagged, unverifiable };
}

/**
 * The automatic citation check for a document the assistant made or changed:
 * "Checking citations…" while it runs, then what it found, with anything that
 * needs attention listed most serious first.
 */
export function CitationCheckStatus({
    documentId,
    versionId,
    requestAuto = false,
}: {
    documentId: string;
    versionId?: string | null;
    /** Ask for a check if the document's citations changed (used when a document is opened). */
    requestAuto?: boolean;
}) {
    const state = useDocumentCitationChecks(documentId, { requestAuto });
    const [open, setOpen] = useState(false);

    if (state.status === "idle") return null;
    if (state.status === "checking") {
        return (
            <div role="status" aria-live="polite">
                <EventBlock isStreaming>
                    <EventLabel>Checking citations…</EventLabel>
                </EventBlock>
            </div>
        );
    }

    const { data } = state;
    if (data.task?.status === "failed" || data.task?.status === "cancelled") {
        return (
            <EventBlock dotColor="gray">
                <span>The citation check did not finish.</span>
            </EventBlock>
        );
    }
    const { lead, detail, flagged } = resultLine(data, versionId);
    if (!flagged.length) {
        return (
            <div role="status" aria-live="polite">
                <EventBlock dotColor="green">
                    <EventLabel>{lead}</EventLabel>
                    {detail && <span> · {detail}</span>}
                </EventBlock>
            </div>
        );
    }
    return (
        <div role="status" aria-live="polite">
            <EventBlock dotColor="red">
                <EventDisclosureButton
                    open={open}
                    onToggle={() => setOpen((value) => !value)}
                    label={lead}
                    detail={`· ${detail}`}
                />
                {open && (
                    <ul className="mt-2 flex flex-col gap-3">
                        {flagged.map((check) => (
                            <li key={check.id} className="min-w-0">
                                <p className="text-gray-700 [overflow-wrap:anywhere]">
                                    <EventLabel>
                                        {VERDICT_LABEL[check.verdict]}
                                    </EventLabel>
                                    {check.citation_text && (
                                        <> · {check.citation_text}</>
                                    )}
                                </p>
                                {(check.support_reason || check.reason) && (
                                    <p className="mt-0.5 text-xs [overflow-wrap:anywhere]">
                                        {check.support_reason || check.reason}
                                    </p>
                                )}
                                {check.excerpt && (
                                    <TextSlabUI className="mt-1">
                                        <p className="text-xs text-gray-700 [overflow-wrap:anywhere]">
                                            “{check.excerpt}”
                                        </p>
                                    </TextSlabUI>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </EventBlock>
        </div>
    );
}
