"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { API_BASE, listDocumentVersions, replaceDocumentVersionFile } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { MarkdownContent } from "@/app/components/assistant/message/MarkdownContent";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";

interface Props {
    documentId: string;
    versionId?: string | null;
    filename: string;
    refetchKey?: number | string;
    rounded?: boolean | "top-right";
    /** Offer editing the text, saved over the version shown. */
    canEdit?: boolean;
}

const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i;
const NO_CITATIONS = new Map();

/** Front matter (`---` block at the very top) as key/value pairs, and the text after it. */
export function splitFrontMatter(text: string): { fields: Array<[string, string]>; body: string } {
    const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return { fields: [], body: text };
    const fields = match[1]
        .split(/\r?\n/)
        .map((line) => /^([\w-]+):\s*(.*)$/.exec(line))
        .filter((field): field is RegExpExecArray => field !== null)
        .map(([, key, value]): [string, string] => [key, value.replace(/^(["'])(.*)\1$/, "$2")]);
    return { fields, body: text.slice(match[0].length) };
}

async function sha256(bytes: ArrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Loaded = { key: string; text?: string; bytes?: ArrayBuffer; failed?: true };

/**
 * A plain-text document (.txt, .md, .csv). Markdown is shown rendered, with
 * any front matter as a short list of details; other text as written, long
 * lines wrapped. Where the reader may edit, Edit opens the source as plain
 * text, and Save writes it over the version shown (refused if the document
 * changed since it was opened).
 */
export function TextView({ documentId, versionId, filename, refetchKey, rounded = true, canEdit = false }: Props) {
    const [state, setState] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const key = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
    const markdown = MARKDOWN.test(filename);

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
                setState({ key, bytes, text: new TextDecoder().decode(bytes) });
            })
            .catch(() => {
                if (!controller.signal.aborted) setState({ key, failed: true });
            });
        return () => controller.abort();
    }, [documentId, versionId, key]);

    // Another document or version: whatever was being edited belongs to the old one.
    useEffect(() => {
        setDraft(null);
        setSaveError(null);
    }, [key]);

    const current = state?.key === key ? state : null;

    const save = async () => {
        if (draft === null || !current?.bytes) return;
        setSaving(true);
        setSaveError(null);
        try {
            const target = versionId ?? (await listDocumentVersions(documentId)).current_version_id;
            if (!target) throw new Error("No version to save over");
            const file = new File([draft], filename, { type: markdown ? "text/markdown" : "text/plain" });
            await replaceDocumentVersionFile(documentId, target, file, undefined, {
                expectedContentSha256: await sha256(current.bytes),
                generatePdf: false,
            });
            setState({ key, text: draft, bytes: await file.arrayBuffer() });
            setDraft(null);
        } catch (error) {
            setSaveError(userFacingApiError(error, "The document could not be saved. Please try again."));
        } finally {
            setSaving(false);
        }
    };

    const editing = draft !== null;
    const toolbar = canEdit && current?.text !== undefined && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-end gap-2 bg-white/90 px-4 py-2 backdrop-blur-sm">
            {saveError && (
                <p role="alert" className="mr-auto text-xs text-red-600 [overflow-wrap:anywhere]">
                    {saveError}
                </p>
            )}
            {editing ? (
                <>
                    <TextButtonUI type="button" disabled={saving} onClick={() => setDraft(null)}>
                        Cancel
                    </TextButtonUI>
                    <TextButtonUI type="button" disabled={saving || draft === current.text} onClick={() => void save()}>
                        {saving ? "Saving…" : "Save"}
                    </TextButtonUI>
                </>
            ) : (
                <TextButtonUI type="button" onClick={() => setDraft(current.text ?? "")}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                </TextButtonUI>
            )}
        </div>
    );

    const { fields, body } = current?.text !== undefined && markdown ? splitFrontMatter(current.text) : { fields: [], body: "" };

    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 flex-col overflow-auto bg-white",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {toolbar}
            {current?.text !== undefined ? (
                editing ? (
                    <textarea
                        aria-label={`${filename} source`}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={markdown}
                        className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-6 pt-2 font-mono text-[13px] leading-relaxed text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                    />
                ) : markdown ? (
                    <article aria-label={filename} className="w-full p-6 pt-2 [overflow-wrap:anywhere]">
                        {fields.length > 0 && (
                            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-gray-500">
                                {fields.map(([name, value]) => (
                                    <div key={name} className="contents">
                                        <dt className="font-medium text-gray-600">{name}</dt>
                                        <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        )}
                        <MarkdownContent
                            text={body}
                            inlineCitationTargets={[]}
                            caseCitations={NO_CITATIONS}
                            caseDocuments={NO_CITATIONS}
                        />
                    </article>
                ) : (
                    <pre
                        aria-label={filename}
                        className="m-0 w-full whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed text-gray-800"
                    >
                        {current.text}
                    </pre>
                )
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
