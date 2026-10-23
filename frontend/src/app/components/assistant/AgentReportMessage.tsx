"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MessageOrigin } from "@mike/contracts";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { MarkdownContent } from "./message/MarkdownContent";
import {
    SUBAGENT_STATUS_TEXT,
    subagentTypeLabel,
} from "./message/SubagentBlock";

type AgentMessage = MessageOrigin["messages"][number];

/** Height a body shows before it folds behind "Show more". */
export const COLLAPSED_REPORT_HEIGHT_PX = 200;

const NO_CITATIONS: [] = [];
const NO_CASE_CITATIONS = new Map();
const NO_CASE_DOCUMENTS = new Map();

function ReportBody({ text }: { text: string }) {
    const bodyId = useId();
    const bodyRef = useRef<HTMLDivElement>(null);
    // Measured, since wrapping depends on the column's width.
    const [foldable, setFoldable] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useLayoutEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const measure = () =>
            setFoldable(body.scrollHeight > COLLAPSED_REPORT_HEIGHT_PX + 40);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        return () => observer.disconnect();
    }, [text]);

    const folded = foldable && !expanded;
    return (
        <div>
            <div className="relative">
                <div
                    ref={bodyRef}
                    id={bodyId}
                    className="[&>div]:mb-0 [&>div]:text-sm"
                    style={
                        folded
                            ? {
                                  maxHeight: COLLAPSED_REPORT_HEIGHT_PX,
                                  overflow: "hidden",
                                  // Fades the cut-off end without a fill colour.
                                  maskImage:
                                      "linear-gradient(to bottom, black 75%, transparent)",
                                  WebkitMaskImage:
                                      "linear-gradient(to bottom, black 75%, transparent)",
                              }
                            : undefined
                    }
                >
                    <MarkdownContent
                        text={text}
                        inlineCitationTargets={NO_CITATIONS}
                        caseCitations={NO_CASE_CITATIONS}
                        caseDocuments={NO_CASE_DOCUMENTS}
                    />
                </div>
            </div>
            {foldable && (
                <div className="mt-1 flex justify-start">
                    <TextButtonUI
                        size="xs"
                        aria-expanded={expanded}
                        aria-controls={bodyId}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? "Show less" : "Show more"}
                    </TextButtonUI>
                </div>
            )}
        </div>
    );
}

function AgentMessageCard({ message }: { message: AgentMessage }) {
    const details = [
        subagentTypeLabel(message.agent_type),
        message.kind === "report" ? "Report" : "Message",
        message.status ? SUBAGENT_STATUS_TEXT[message.status] : null,
    ].filter(Boolean);
    return (
        <li
            className={`flex min-w-0 flex-col gap-2 rounded-xl px-4 py-3 ${LIQUID_GLASS_FLAT_CLASS}`}
        >
            <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
                    {message.from}
                </p>
                <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
                    {details.join(" · ")}
                </p>
            </div>
            <ReportBody text={message.body} />
        </li>
    );
}

/**
 * Reports and messages from the chat's background subagents, which the server
 * delivered while the chat was idle and then answered. They did not come from
 * the reader, so they read as a card from the subagents rather than as a
 * prompt bubble: no author, no edit, no branch controls. The stored prompt
 * text is model-facing and is never shown.
 */
export function AgentReportMessage({
    origin,
    messageId,
}: {
    origin: MessageOrigin;
    messageId?: string;
}) {
    return (
        <section
            aria-label="Messages from background subagents"
            data-message-id={messageId}
            data-origin={origin.kind}
            className="w-full min-w-0"
        >
            <p className="mb-2 text-xs text-gray-500">
                From background subagents
            </p>
            <ul className="flex flex-col gap-3">
                {origin.messages.map((message, index) => (
                    <AgentMessageCard
                        key={`${message.child_id}-${index}`}
                        message={message}
                    />
                ))}
            </ul>
        </section>
    );
}
