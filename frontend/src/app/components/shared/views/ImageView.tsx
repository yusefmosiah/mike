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
 * An image document, shown whole and scaled to fit. The stored file is the
 * cleaned copy (upright, no metadata), served from /file.
 */
export function ImageView({ documentId, versionId, filename, refetchKey, rounded = true }: Props) {
    const [state, setState] = useState<{ key: string; url?: string; failed?: true } | null>(null);
    const key = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;

    useEffect(() => {
        const controller = new AbortController();
        let url: string | undefined;
        const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
        authenticatedFetch(`${API_BASE}/single-documents/${documentId}/file${qs}`, {
            credentials: "include",
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                url = URL.createObjectURL(await response.blob());
                setState({ key, url });
            })
            .catch(() => {
                if (!controller.signal.aborted) setState({ key, failed: true });
            });
        return () => {
            controller.abort();
            if (url) URL.revokeObjectURL(url);
        };
    }, [documentId, versionId, key]);

    const current = state?.key === key ? state : null;
    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 items-center justify-center overflow-auto bg-app-background p-4",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {current?.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- an authenticated blob URL, not an optimisable asset
                <img src={current.url} alt={filename} className="max-h-full max-w-full object-contain" />
            ) : current?.failed ? (
                <p role="alert" className="text-sm text-gray-600">
                    The image could not be loaded.
                </p>
            ) : (
                <div aria-label="Loading image" role="status" className="h-2/3 w-2/3 animate-pulse rounded-lg bg-gray-200/70" />
            )}
        </div>
    );
}
