"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { fetchDocumentText } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";

/** Pasting every character is a lot — confirm before writing the clipboard. */
const COPY_CONFIRM_CHARS = 100_000;

/**
 * Copy a document's whole text. When the live docx editor registered `onCopy`
 * (unsaved edits and rich clipboard flavours included), that path wins; the
 * server-flattened plain text is the fallback and every other format's way.
 */
export function DocumentCopyButton({
    documentId,
    versionId,
    isReloading,
    onCopy,
}: {
    documentId: string;
    versionId: string | null;
    isReloading?: boolean;
    /** Rich full-document copy while the docx editor is live; plain text otherwise. */
    onCopy?: () => Promise<void> | undefined;
}) {
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingLarge, setPendingLarge] = useState<string | null>(null);

    const writeClipboard = async (text: string) => {
        const localCopy = onCopy?.();
        if (localCopy) {
            try {
                await localCopy;
                return;
            } catch {
                // Fall through to the plain text already fetched.
            }
        }
        await navigator.clipboard.writeText(text);
    };

    const flashCopied = () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        setError(null);
        try {
            const { text, chars } = await fetchDocumentText(
                documentId,
                versionId,
            );
            if (!text) throw new Error("empty text");
            if (chars > COPY_CONFIRM_CHARS) {
                setPendingLarge(text);
                return;
            }
            await writeClipboard(text);
            flashCopied();
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "The document could not be copied. Please try again.",
                ),
            );
        } finally {
            setBusy(false);
        }
    };

    const confirmLarge = async () => {
        const text = pendingLarge;
        setPendingLarge(null);
        if (text === null) return;
        setBusy(true);
        try {
            await writeClipboard(text);
            flashCopied();
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "The document could not be copied. Please try again.",
                ),
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <WarningPopup
                open={!!error}
                title="Copy failed"
                message={error}
                onClose={() => setError(null)}
            />
            <ConfirmPopup
                open={pendingLarge !== null}
                title="Copy the whole document?"
                message="This document is very large — pasting its full text may be slow in other apps. Copy everything anyway?"
                confirmLabel="Copy all"
                onConfirm={() => void confirmLarge()}
                onCancel={() => setPendingLarge(null)}
            />
            <TextButtonUI
                size="icon-xs"
                aria-label="Copy document text"
                title="Copy document text"
                onClick={handleClick}
                loading={!!(busy || isReloading)}
            >
                {copied ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
            </TextButtonUI>
        </>
    );
}
