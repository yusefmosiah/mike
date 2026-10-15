"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Copy, Pencil, Waypoints } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import type { MessageFile } from "../shared/types";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { cn } from "@/app/lib/utils";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { useIsTouchPrimary } from "@/app/hooks/useIsTouchPrimary";
import { useLongPress } from "@/app/hooks/useLongPress";
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
     * Starts editing this message in the composer, where its text and files
     * can both change; the edit is saved as a sibling branch (the original
     * row is never rewritten). When absent, no edit control renders.
     */
    onEdit?: () => void;
    /** This message is the one loaded in the composer for editing. */
    beingEdited?: boolean;
    /**
     * Keeps the edit control on screen but unusable, while an answer
     * streams: taking it away and bringing it back would shift everything
     * below it when the answer ends.
     */
    editDisabled?: boolean;
    /** Steps to the previous (-1) or next (1) sibling branch. */
    onNavigateSibling?: (dir: -1 | 1) => void;
    /** Who sent this prompt, shown when more than one person carries the thread. */
    authorLabel?: string | null;
    /** Why this message is not in the thread (a `/nr` message that could not be saved). */
    error?: string;
}

/**
 * Height a prompt shows before it folds behind "Show more": twelve lines of
 * text-sm. A taller prompt would push its own top off screen once it is
 * scrolled into place above the answer.
 */
export const COLLAPSED_PROMPT_HEIGHT_PX = 240;

export function UserMessage({
    content,
    files,
    workflow,
    onFileClick,
    onWorkflowClick,
    messageId,
    sibling,
    onEdit,
    beingEdited = false,
    editDisabled = false,
    onNavigateSibling,
    authorLabel,
    error,
}: Props) {
    const hasFiles = files && files.length > 0;
    const textRef = useRef<HTMLParagraphElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);
    // Whether the prompt is taller than the folded height; measured, since
    // wrapping depends on the bubble's width.
    const [foldable, setFoldable] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useLayoutEffect(() => {
        const text = textRef.current;
        if (!text) return;
        const measure = () =>
            setFoldable(text.scrollHeight > COLLAPSED_PROMPT_HEIGHT_PX + 40);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(text);
        return () => observer.disconnect();
    }, [content]);
    const folded = foldable && !expanded;

    // On a touch screen the prompt's actions live in a press-and-hold menu,
    // as in the phone's own apps, instead of a small pencil under it.
    const touch = useIsTouchPrimary();
    const [menuOpen, setMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    // The finger that opened the menu is still down; its release must not
    // pick whichever item opened under it.
    const openingPointerRef = useRef<number | null>(null);
    const openMenu = useCallback((pointerId: number) => {
        openingPointerRef.current = pointerId;
        setMenuOpen(true);
    }, []);
    const longPress = useLongPress(openMenu, touch);
    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard refused (no permission); nothing to undo.
        }
    };

    const collapse = () => {
        setExpanded(false);
        // The button that was tapped sat at the end of the long text: bring
        // the folded prompt back into view rather than leave the reader below it.
        requestAnimationFrame(() => {
            const bubble = bubbleRef.current;
            if (bubble && bubble.getBoundingClientRect().top < 0) {
                bubble.scrollIntoView({ block: "start", behavior: "smooth" });
            }
        });
    };

    return (
        <div className="w-full flex justify-end" data-message-id={messageId}>
            <div className="max-w-[80%] flex flex-col items-end gap-1">
                {authorLabel && (
                    <span className="max-w-full px-1 text-right text-xs text-gray-500 [overflow-wrap:anywhere]">
                        {authorLabel}
                    </span>
                )}
                <div
                    ref={bubbleRef}
                    {...(touch ? longPress : {})}
                    // Ringed while it is loaded in the composer for editing.
                    className={cn(
                        "relative w-full bg-gray-100 rounded-xl px-4 py-3 transition-[box-shadow,background-color,transform]",
                        beingEdited && "ring-2 ring-blue-500/50",
                        // The phone's own selection callout would fight the menu.
                        touch && "select-none [-webkit-touch-callout:none]",
                        menuOpen && "scale-[0.98] bg-gray-200",
                    )}
                >
                    {touch && (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                        >
                            {/* Anchors the menu under the bubble, and lets a
                                screen reader, which cannot press and hold,
                                reach the same actions. */}
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className="absolute bottom-0 right-0 size-px overflow-hidden opacity-0 focus-visible:size-auto focus-visible:rounded-md focus-visible:bg-white focus-visible:px-2 focus-visible:py-1 focus-visible:text-xs focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                                >
                                    Prompt actions
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                className="min-w-40"
                                onCloseAutoFocus={(event) =>
                                    event.preventDefault()
                                }
                                onPointerUpCapture={(event) => {
                                    if (
                                        event.pointerId ===
                                        openingPointerRef.current
                                    ) {
                                        openingPointerRef.current = null;
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }
                                }}
                            >
                                {onEdit && (
                                    <DropdownMenuItem
                                        disabled={editDisabled}
                                        onSelect={onEdit}
                                    >
                                        <Pencil />
                                        Edit
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={copyPrompt}>
                                    <Copy />
                                    Copy
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    {beingEdited && (
                        <span className="mb-1 block text-xs font-medium text-blue-700">
                            Editing below
                        </span>
                    )}
                    <div className="relative">
                        <p
                            ref={textRef}
                            id={messageId ? `prompt-${messageId}` : undefined}
                            className="text-sm text-gray-900 whitespace-pre-wrap [overflow-wrap:anywhere]"
                            style={
                                folded
                                    ? {
                                          maxHeight: COLLAPSED_PROMPT_HEIGHT_PX,
                                          overflow: "hidden",
                                      }
                                    : undefined
                            }
                        >
                            {content}
                        </p>
                        {folded && (
                            <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-gray-100 to-transparent"
                            />
                        )}
                    </div>
                    {foldable && (
                        <div className="mt-1 flex justify-end">
                            <TextButtonUI
                                size="xs"
                                aria-expanded={expanded}
                                aria-controls={
                                    messageId
                                        ? `prompt-${messageId}`
                                        : undefined
                                }
                                onClick={() =>
                                    expanded ? collapse() : setExpanded(true)
                                }
                            >
                                {expanded ? "Show less" : "Show more"}
                            </TextButtonUI>
                        </div>
                    )}
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
                                    const className = `inline-flex items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-2.5 text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS} backdrop-blur-xl`;
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
                                    return f.document_id && onFileClick ? (
                                        <button
                                            key={i}
                                            type="button"
                                            onClick={() => onFileClick(f)}
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
                {error && (
                    <p
                        role="alert"
                        className="max-w-full px-1 text-right text-xs text-red-600 [overflow-wrap:anywhere]"
                    >
                        {error}
                    </p>
                )}
                {copied && (
                    <p role="status" className="px-1 text-xs text-gray-500">
                        Copied
                    </p>
                )}
                {((onEdit && !touch) || (sibling && sibling.total > 1)) && (
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
                        {onEdit && !touch && (
                            <button
                                type="button"
                                aria-label="Edit prompt"
                                onClick={onEdit}
                                disabled={editDisabled}
                                className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:pointer-events-none disabled:opacity-40"
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
