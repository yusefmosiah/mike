"use client";

import { useEffect, useState } from "react";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { API_BASE } from "@/app/lib/mikeApi";

/**
 * A document file as an object URL: fetched with the session, revoked on
 * unmount, and failed in one `role="alert"`-ready state. Shared by the
 * document viewer's image pane and media blocks inside responses so a chat
 * preview and the viewer read the same bytes the same way.
 */
export function useDocumentFileUrl(
    documentId: string,
    versionId: string | null | undefined,
    refetchKey?: number | string,
): { url?: string; failed?: true; loading: boolean } {
    const [state, setState] = useState<{
        key: string;
        url?: string;
        failed?: true;
    } | null>(null);
    const key = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;

    useEffect(() => {
        const controller = new AbortController();
        let url: string | undefined;
        const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
        authenticatedFetch(
            `${API_BASE}/single-documents/${documentId}/file${qs}`,
            {
                credentials: "include",
                signal: controller.signal,
            },
        )
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
    return { url: current?.url, failed: current?.failed, loading: !current };
}
