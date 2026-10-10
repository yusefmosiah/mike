"use client";

import { useEffect, useState } from "react";
import {
    autoCheckDocumentCitations,
    getDocumentCitationChecks,
    type DocumentCitationChecks,
} from "@/app/lib/mikeApi";

/** How often to look again while a check is scheduled or running. */
export const CITATION_POLL_MS = 4_000;
/** Stop looking after this long; a check that has not finished by then is reported as unfinished. */
const MAX_POLL_MS = 15 * 60_000;

export type CitationCheckState =
    | { status: "idle" }
    | { status: "checking"; data: DocumentCitationChecks }
    | { status: "done"; data: DocumentCitationChecks };

export function citationCheckInProgress(data: DocumentCitationChecks): boolean {
    return (
        !!data.auto_pending ||
        data.task?.status === "queued" ||
        data.task?.status === "running"
    );
}

/**
 * A document's citation check, followed while it runs. Checks start on their
 * own (backend citations.auto.ts) after the assistant edits a document;
 * `requestAuto` also asks for one when the document is opened, which covers
 * uploads. A document with no check and none scheduled stays `idle`, and so
 * does one whose check could not be loaded: this line is informational, so a
 * failure to load it shows nothing rather than an error.
 */
export function useDocumentCitationChecks(
    documentId: string | null | undefined,
    { requestAuto = false }: { requestAuto?: boolean } = {},
): CitationCheckState {
    // Keyed by document, so a different document reads as idle until its own
    // check has loaded.
    const [loaded, setLoaded] = useState<{
        documentId: string;
        state: CitationCheckState;
    } | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const setState = (state: CitationCheckState) =>
            setLoaded({ documentId, state });
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        const startedAt = Date.now();

        const load = async () => {
            try {
                const data = await getDocumentCitationChecks(
                    documentId,
                    controller.signal,
                );
                if (cancelled) return;
                if (!data.task && !data.auto_pending) {
                    setState({ status: "idle" });
                    return;
                }
                const running = citationCheckInProgress(data);
                setState({ status: running ? "checking" : "done", data });
                if (running && Date.now() - startedAt < MAX_POLL_MS) {
                    timer = setTimeout(load, CITATION_POLL_MS);
                }
            } catch {
                if (!cancelled) setState({ status: "idle" });
            }
        };

        void (async () => {
            if (requestAuto) {
                try {
                    await autoCheckDocumentCitations(documentId);
                } catch {
                    // Informational: the latest stored check still shows.
                }
            }
            if (!cancelled) await load();
        })();

        return () => {
            cancelled = true;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [documentId, requestAuto]);

    return loaded && loaded.documentId === documentId
        ? loaded.state
        : { status: "idle" };
}
