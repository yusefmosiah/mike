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

type Loaded = { key: string; html?: string; failed?: true };

/**
 * An HTML page (.html), run inside a sandboxed frame. The page is untrusted:
 * it runs scripts, but with an opaque origin (no `allow-same-origin`), so it
 * cannot reach this app's cookies, storage or DOM, and it is never injected
 * into this document.
 */
export function HtmlView({ documentId, versionId, filename, refetchKey, rounded = true }: Props) {
    const [state, setState] = useState<Loaded | null>(null);
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
                const bytes = await response.arrayBuffer();
                setState({ key, html: new TextDecoder().decode(bytes) });
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
                "flex min-h-0 flex-1 flex-col overflow-hidden bg-white",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {current?.html !== undefined ? (
                <>
                    <p className="px-4 py-1.5 text-xs text-gray-500">
                        Embedded videos may only play on the published page.
                    </p>
                    <iframe
                        title={filename}
                        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                        referrerPolicy="no-referrer"
                        srcDoc={current.html}
                        className="min-h-0 w-full flex-1 border-0 bg-white"
                    />
                </>
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
