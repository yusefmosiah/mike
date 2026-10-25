"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { GlassCardUI } from "./GlassCardUI";

export interface PreResponseWrapperUIProps {
    children: ReactNode;
    stepCount: number;
    /** What the steps read, shown after the count once the work is done. */
    detail?: string;
    /** What the work did, in a few sentences: shown under the line, open or closed. */
    summary?: string;
    shouldMinimize: boolean;
    isStreaming: boolean;
    forceOpen?: boolean;
}

/**
 * Platform-neutral disclosure for pre-answer activity. Hosts supply activity
 * rows and surface styling; this component owns only presentation and local
 * disclosure behavior.
 */
export function PreResponseWrapperUI({
    children,
    stepCount,
    detail,
    summary,
    shouldMinimize,
    isStreaming,
    forceOpen = false,
}: PreResponseWrapperUIProps) {
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(!shouldMinimize);
    // Once answer content causes a minimize, do not reopen during a transient
    // streaming-state render unless the host explicitly forces the panel open.
    const hasMinimizedRef = useRef(shouldMinimize);

    useEffect(() => {
        if (forceOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes the disclosure with host streaming state
            setIsOpen(true);
            return;
        }
        if (shouldMinimize) hasMinimizedRef.current = true;
        if (userToggled) return;
        setIsOpen(!shouldMinimize && !hasMinimizedRef.current);
    }, [forceOpen, shouldMinimize, userToggled]);

    const stepWord = `step${stepCount === 1 ? "" : "s"}`;
    const label = isStreaming
        ? "Working"
        : `Completed in ${stepCount} ${stepWord}${detail ? ` · ${detail}` : ""}`;
    const shownSummary = isStreaming ? undefined : summary?.trim();

    return (
        <GlassCardUI>
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((value) => !value);
                }}
                aria-expanded={isOpen}
                className={`flex w-full items-center justify-between px-3 font-serif text-sm text-gray-500 transition-colors hover:text-gray-700 ${isOpen || shownSummary ? "pt-2" : "py-2"}`}
            >
                <span className="flex min-w-0 items-baseline">
                    <span className="min-w-0 text-left [overflow-wrap:anywhere]">{label}</span>
                    {isStreaming && (
                        <span
                            className="ml-1 inline-flex shrink-0 items-baseline"
                            aria-hidden="true"
                        >
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0s]" />
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.2s]" />
                            <span className="h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.4s]" />
                        </span>
                    )}
                </span>
                <ChevronDown
                    aria-hidden="true"
                    className={`relative top-px ml-2 h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>

            {shownSummary ? (
                <p
                    className={`whitespace-pre-line px-3 pt-1 font-serif text-sm text-gray-700 [overflow-wrap:anywhere] ${isOpen ? "" : "pb-2"}`}
                >
                    {shownSummary}
                </p>
            ) : null}

            {isOpen && (
                <div className="mt-3 flex flex-col gap-4 px-3 pb-2">
                    {children}
                </div>
            )}
        </GlassCardUI>
    );
}
