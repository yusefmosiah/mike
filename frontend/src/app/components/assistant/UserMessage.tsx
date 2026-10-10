"use client";

import { useState } from "react";
import { Pencil, Waypoints } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import type { MessageFile } from "../shared/types";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { BranchNavigator } from "./BranchNavigator";

interface Props {
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
    onFileClick?: (file: MessageFile) => void;
    /** Reveals the workflow this message ran, in the workflow modal. */
    onWorkflowClick?: (workflow: { id: string; title: string }) => void;
    /** Server id of this message. Set on stored chats; renders as data attr. */
    messageId?: string;
    /** Branch position when this message has siblings (tree chats). */
    sibling?: { index: number; total: number } | null;
    /**
     * Saves an edited copy of this message as a sibling branch (the original
     * row is never rewritten). When absent, no edit control renders.
     */
    onEditBranch?: (content: string) => void | Promise<void>;
    /** Steps to the previous (-1) or next (1) sibling branch. */
    onNavigateSibling?: (dir: -1 | 1) => void;
    /** Who sent this prompt, shown when more than one person carries the thread. */
    authorLabel?: string | null;
}

/** Visible rows for the editor: wrapped lines included, between 2 and 8. */
function editorRows(text: string): number {
    const wrapped = text
        .split("\n")
        .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 72)), 0);
    return Math.min(8, Math.max(2, wrapped));
}

export function UserMessage({
    content,
    files,
    workflow,
    onFileClick,
    onWorkflowClick,
    messageId,
    sibling,
    onEditBranch,
    onNavigateSibling,
    authorLabel,
}: Props) {
    const hasFiles = files && files.length > 0;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(content);
    const [saving, setSaving] = useState(false);

    const openEditor = () => {
        setDraft(content);
        setEditing(true);
    };

    const handleSave = async () => {
        if (!onEditBranch || saving) return;
        const edited = draft.trim();
        if (!edited) return;
        setSaving(true);
        try {
            await onEditBranch(edited);
            setEditing(false);
        } catch {
            // Keep the editor open so the draft is not lost; the host reports
            // the failure through its own error notice.
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="w-full flex justify-end" data-message-id={messageId}>
            {/* While editing, the bubble takes the full 80% so a long prompt
                is editable at a readable width instead of its old size. */}
            <div
                className={`max-w-[80%] flex flex-col items-end gap-1 ${editing ? "w-full" : ""}`}
            >
                {authorLabel && (
                    <span className="max-w-full px-1 text-right text-xs text-gray-500 [overflow-wrap:anywhere]">
                        {authorLabel}
                    </span>
                )}
                {editing ? (
                    <form
                        className="w-full bg-gray-100 rounded-xl px-4 py-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void handleSave();
                        }}
                    >
                        <textarea
                            aria-label="Edit message"
                            value={draft}
                            rows={editorRows(draft)}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Escape") setEditing(false);
                            }}
                            autoFocus
                            className="keyboard-focus-ring w-full resize-none rounded-md bg-transparent text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        />
                        <div className="flex justify-end items-center gap-2 mt-2">
                            <TextButtonUI onClick={() => setEditing(false)}>
                                Cancel
                            </TextButtonUI>
                            <PillButtonUI
                                type="submit"
                                size="xs"
                                tone="black"
                                disabled={!draft.trim()}
                                loading={saving}
                            >
                                Save
                            </PillButtonUI>
                        </div>
                    </form>
                ) : (
                    <div className="w-full bg-gray-100 rounded-xl px-4 py-3">
                        <p className="text-sm text-gray-900 whitespace-pre-wrap">
                            {content}
                        </p>
                        {(workflow || hasFiles) && (
                            <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                                {workflow && (
                                    <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-blue-600">
                                        {onWorkflowClick ? (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onWorkflowClick(workflow)
                                                }
                                                aria-label={`Open workflow ${workflow.title}`}
                                                className="inline-flex min-w-0 items-center gap-1 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                            >
                                                <Waypoints className="h-2.5 w-2.5 shrink-0" />
                                                <span className="max-w-[140px] truncate">
                                                    {workflow.title}
                                                </span>
                                            </button>
                                        ) : (
                                            <>
                                                <Waypoints className="h-2.5 w-2.5 shrink-0" />
                                                <span className="max-w-[140px] truncate">
                                                    {workflow.title}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                )}
                                {hasFiles &&
                                    files.map((f, i) => {
                                        const className =
                                            `inline-flex items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-2.5 text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS} backdrop-blur-xl`;
                                        const fileContent = (
                                            <>
                                                <FileTypeIcon
                                                    fileType={f.filename}
                                                    className="h-2.5 w-2.5"
                                                />
                                                <span className="max-w-[140px] truncate">
                                                    {f.filename}
                                                </span>
                                            </>
                                        );
                                        return f.document_id &&
                                            onFileClick ? (
                                            <button
                                                key={i}
                                                type="button"
                                                onClick={() =>
                                                    onFileClick(f)
                                                }
                                                aria-label={`Open ${f.filename}`}
                                                className={`${className} cursor-pointer transition-colors hover:bg-white/80`}
                                            >
                                                {fileContent}
                                            </button>
                                        ) : (
                                            <div key={i} className={className}>
                                                {fileContent}
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                    </div>
                )}
                {!editing &&
                    (onEditBranch ||
                        (sibling && sibling.total > 1)) && (
                        <div className="flex items-center gap-1">
                            {sibling && sibling.total > 1 && (
                                <BranchNavigator
                                    index={sibling.index}
                                    total={sibling.total}
                                    onPrev={
                                        onNavigateSibling
                                            ? () => onNavigateSibling(-1)
                                            : undefined
                                    }
                                    onNext={
                                        onNavigateSibling
                                            ? () => onNavigateSibling(1)
                                            : undefined
                                    }
                                />
                            )}
                            {onEditBranch && (
                                <button
                                    type="button"
                                    aria-label="Edit prompt"
                                    onClick={openEditor}
                                    className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                                >
                                    <Pencil className="h-3 w-3" />
                                </button>
                            )}
                        </div>
                    )}
            </div>
        </div>
    );
}
