"use client";

import type { ReactNode } from "react";
import { PreResponseWrapperUI } from "@/shared/ui/PreResponseWrapperUI";

export function PreResponseWrapper({
    children,
    stepCount,
    detail,
    summary,
    shouldMinimize,
    isStreaming,
    forceOpen = false,
}: {
    children: ReactNode;
    stepCount: number;
    /** What the steps read, such as "3 documents, 2 web pages". */
    detail?: string;
    /** What the work did, written from its step summaries. */
    summary?: string;
    shouldMinimize: boolean;
    isStreaming: boolean;
    forceOpen?: boolean;
}) {
    return (
        <PreResponseWrapperUI
            stepCount={stepCount}
            detail={detail}
            summary={summary}
            shouldMinimize={shouldMinimize}
            isStreaming={isStreaming}
            forceOpen={forceOpen}
        >
            {children}
        </PreResponseWrapperUI>
    );
}
