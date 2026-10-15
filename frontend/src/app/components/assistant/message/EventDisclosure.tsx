"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * The pieces every event block's first line is built from. They exist so the
 * timeline reads as one thing: before this, each block hand-rolled its own
 * chevron size, rotation direction, and hover shade, and they disagreed.
 *
 * Colour and font come from `EventBlock`'s wrapper — nothing here restates
 * them, so a block that is nested somewhere else still inherits correctly.
 */

/** The bold lead-in of an event line ("Created", "Read Workflow", …). */
export function EventLabel({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return <span className={cn("font-medium", className)}>{children}</span>;
}

/**
 * The disclosure chevron: pointing right when closed, down when open, so the
 * direction always means "where the content is".
 */
export function EventChevron({ open }: { open: boolean }) {
    return (
        <ChevronDown
            size={12}
            aria-hidden="true"
            className={cn(
                "relative top-px ml-1 shrink-0 transition-transform duration-200",
                open ? "" : "-rotate-90",
            )}
        />
    );
}

/**
 * A whole event line that opens something: label, optional detail, the
 * streaming ellipsis, and the chevron. Always reports `aria-expanded`, which
 * one of the hand-rolled versions used to forget.
 */
export function EventDisclosureButton({
    open,
    onToggle,
    label,
    detail,
    isStreaming,
}: {
    open: boolean;
    onToggle: () => void;
    label: ReactNode;
    detail?: ReactNode;
    /** Appends the in-progress ellipsis the timeline uses elsewhere. */
    isStreaming?: boolean;
}) {
    return (
        <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            // The padding is the tap target; the negative margin keeps the
            // line where it was.
            className="-mx-1.5 -my-1 inline-flex min-h-7 items-center rounded-md px-1.5 py-1 text-left transition-colors hover:bg-gray-100/80 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 max-md:-my-1.5 max-md:min-h-9 max-md:py-1.5"
        >
            <EventLabel>{label}</EventLabel>
            {detail ? <span>&nbsp;{detail}</span> : null}
            {isStreaming ? <span>...</span> : null}
            <EventChevron open={open} />
        </button>
    );
}
