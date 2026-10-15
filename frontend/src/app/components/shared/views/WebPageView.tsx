"use client";

import { useEffect, useRef, useState } from "react";
import { getChatWebPage, type ChatWebPage } from "@/app/lib/mikeApi";
import { MarkdownContent } from "@/app/components/assistant/message/MarkdownContent";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import type { PanelDocument, PanelDocumentQuote } from "../types";
import { webPageRef } from "../types";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
    QUOTE_HIGHLIGHT_CLASS,
} from "./highlightDocxQuote";

const NO_CITATIONS = new Map();

type Loaded = { key: string; page?: ChatWebPage; failed?: true };

/**
 * A quote as the rendered page reads it. Quotes are copied from the page's
 * source text, which for a search result is Markdown: a link's target is not
 * on the rendered page, so it would stop the quote matching. Brackets and
 * emphasis marks need nothing, since matching compares letters and digits.
 */
export function quoteAsRendered(quote: string): string {
    return quote.replace(/\]\([^)\s]*\)/g, "]");
}

/**
 * The reader view of a cited web page: the copy saved when the answer was
 * written, reduced to its main content and rendered like a Markdown file,
 * with the active quote highlighted. The live page is one click away in the
 * title row ("Open original"); this view never loads anything from the site.
 */
export function WebPageView({
    document,
    activeQuote,
    quoteFocusKey,
}: {
    document: PanelDocument;
    activeQuote?: PanelDocumentQuote | null;
    quoteFocusKey?: number;
}) {
    const [state, setState] = useState<Loaded | null>(null);
    // A retry is a new key, so the view shows loading again until it lands.
    const [attemptKey, setAttemptKey] = useState(0);
    const ref = webPageRef(document.document_id);
    const chatId = ref?.chatId ?? null;
    const snapshotId = ref?.snapshotId ?? null;
    const key = ref ? `${chatId}:${snapshotId}:${attemptKey}` : null;
    const contentRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!chatId || !snapshotId || !key) return;
        let cancelled = false;
        getChatWebPage(chatId, snapshotId)
            .then((page) => {
                if (!cancelled) setState({ key, page });
            })
            .catch(() => {
                if (!cancelled) setState({ key, failed: true });
            });
        return () => {
            cancelled = true;
        };
    }, [chatId, snapshotId, key]);

    const current = key && state?.key === key ? state : null;
    const page = current?.page;

    useEffect(() => {
        const root = contentRef.current;
        if (!root) return;
        clearDocxQuoteHighlights(root);
        if (!activeQuote) return;
        const match = highlightDocxQuote(
            root,
            page?.markdown ? quoteAsRendered(activeQuote.quote) : activeQuote.quote,
        );
        if (!match) return;
        root.querySelectorAll(`.${QUOTE_HIGHLIGHT_CLASS}`).forEach((element) =>
            element.classList.add("case-quote-highlight"),
        );
        const timer = window.setTimeout(() => {
            match.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
        return () => window.clearTimeout(timer);
    }, [activeQuote, page, quoteFocusKey]);

    return (
        <div
            data-document-scroll-viewport
            className="flex min-h-0 flex-1 flex-col overflow-auto bg-white"
        >
            {!ref ? (
                <p className="m-auto max-w-sm p-6 text-center text-sm text-gray-600">
                    No copy of this page was saved with the answer. Open the
                    original to read it on its site.
                </p>
            ) : page ? (
                <article
                    ref={contentRef}
                    aria-label={document.title}
                    className="case-document-content w-full p-6 pt-4 [overflow-wrap:anywhere]"
                >
                    {page.markdown ? (
                        <MarkdownContent
                            text={page.markdown}
                            inlineCitationTargets={[]}
                            caseCitations={NO_CITATIONS}
                            caseDocuments={NO_CITATIONS}
                        />
                    ) : (
                        <div className="whitespace-pre-wrap font-serif text-base leading-7 text-gray-900">
                            {page.text}
                        </div>
                    )}
                </article>
            ) : current?.failed ? (
                <div role="alert" className="m-auto flex flex-col items-center gap-3 p-6 text-center">
                    <p className="text-sm text-gray-600">
                        The saved page could not be loaded.
                    </p>
                    <TextButtonUI type="button" onClick={() => setAttemptKey((n) => n + 1)}>
                        Try again
                    </TextButtonUI>
                </div>
            ) : (
                <div aria-label="Loading page" role="status" className="w-full space-y-3 p-6">
                    <div className="h-5 w-1/2 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-5/6 animate-pulse rounded bg-gray-200/70" />
                </div>
            )}
        </div>
    );
}
