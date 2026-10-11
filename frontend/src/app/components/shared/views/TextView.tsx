"use client";

import { useEffect, useState } from "react";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { API_BASE } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

interface Props {
    documentId: string;
    versionId?: string | null;
    filename: string;
    refetchKey?: number | string;
    rounded?: boolean | "top-right";
}

/**
 * A plain-text document (.txt, .md, .csv), shown as its text. Markdown is
 * shown as written, not rendered; long lines wrap.
 */
export function TextView({ documentId, versionId, filename, refetchKey, rounded = true }: Props) {
    const [state, setState] = useState<{ key: string; text?: string; failed?: true } | null>(null);
    const key = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;

    useEffect(() => {
        const controller = new AbortController();
        const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
        authenticatedFetch(`${API_BASE}/single-documents/${documentId}/file${qs}`, {
            credentials: "include",
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                setState({ key, text: await response.text() });
            })
            .catch(() => {
                if (!controller.signal.aborted) setState({ key, failed: true });
            });
        return () => controller.abort();
    }, [documentId, versionId, key]);

    const current = state?.key === key ? state : null;
    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 overflow-auto bg-white",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {current?.text !== undefined ? (
                <pre
                    aria-label={filename}
                    className="m-0 w-full whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed text-gray-800"
                >
                    {current.text}
                </pre>
            ) : current?.failed ? (
                <p role="alert" className="m-auto text-sm text-gray-600">
                    The document could not be loaded.
                </p>
            ) : (
                <div aria-label="Loading document" role="status" className="w-full space-y-3 p-6">
                    <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-5/6 animate-pulse rounded bg-gray-200/70" />
                </div>
            )}
        </div>
    );
}
