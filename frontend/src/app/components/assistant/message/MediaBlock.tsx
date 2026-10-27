"use client";

import { useState } from "react";
import { API_BASE } from "@/app/lib/mikeApi";
import { useDocumentFileUrl } from "@/app/hooks/useDocumentFileUrl";
import type { AssistantEvent } from "@/app/components/shared/types";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { cn } from "@/app/lib/utils";

type MediaEvent = Extract<AssistantEvent, { type: "media" }>;

export interface MediaBlockOpenArgs {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
}

interface MediaBlockProps {
    /** Consecutive media events from one message, in order. */
    events: MediaEvent[];
    onOpenDocument?: (args: MediaBlockOpenArgs) => void;
}

/** One image tile: click opens the same document in the viewer. */
function MediaImage({
    event,
    onOpen,
}: {
    event: MediaEvent;
    onOpen?: (event: MediaEvent) => void;
}) {
    const { url, failed } = useDocumentFileUrl(
        event.document_id,
        event.version_id,
    );
    const caption = event.caption ?? event.filename;

    if (failed) {
        return (
            <p role="alert" className="text-sm text-gray-600">
                {event.filename} could not be loaded.
            </p>
        );
    }
    if (!url) {
        return (
            <div
                aria-label={`Loading ${event.filename}`}
                role="status"
                className="aspect-[4/3] w-full animate-pulse rounded-lg bg-gray-200/70"
            />
        );
    }
    const labelled = caption !== event.filename;
    const img = (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated blob URL, not an optimisable asset
        <img
            src={url}
            alt={labelled ? "" : event.filename}
            loading="lazy"
            className="max-h-[28rem] w-full object-contain bg-gray-100/60"
        />
    );
    return (
        <figure className="w-full">
            {onOpen ? (
                <button
                    type="button"
                    onClick={() => onOpen(event)}
                    aria-label={`Open ${event.filename} in the document viewer`}
                    className="block w-full cursor-pointer overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    {img}
                </button>
            ) : (
                img
            )}
            {labelled && (
                <figcaption className="mt-1 break-words text-sm text-gray-600">
                    {caption}
                </figcaption>
            )}
        </figure>
    );
}

/** Audio or video reads /file through the session cookie, so it streams. */
function mediaSrc(event: MediaEvent): string {
    const qs = event.version_id
        ? `?version_id=${encodeURIComponent(event.version_id)}`
        : "";
    return `${API_BASE}/single-documents/${event.document_id}/file${qs}`;
}

function MediaPlayer({
    event,
    onOpen,
}: {
    event: MediaEvent;
    onOpen?: (event: MediaEvent) => void;
}) {
    const src = mediaSrc(event);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const failed = failedSrc === src;
    const caption = event.caption ?? event.filename;

    return (
        <div className="flex w-full flex-col gap-1">
            <p className="max-w-full break-words text-sm text-gray-700">
                {caption}
            </p>
            {failed ? (
                <p role="alert" className="text-sm text-gray-600">
                    {event.kind === "video"
                        ? "The video could not be played."
                        : "The audio could not be played."}
                </p>
            ) : event.kind === "video" ? (
                <video
                    key={src}
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={event.filename}
                    onError={() => setFailedSrc(src)}
                    className="max-h-[28rem] w-full rounded-lg bg-black"
                />
            ) : (
                <audio
                    key={src}
                    src={src}
                    controls
                    preload="metadata"
                    aria-label={event.filename}
                    onError={() => setFailedSrc(src)}
                    className="w-full"
                />
            )}
            {onOpen && (
                <div>
                    <TextButtonUI
                        onClick={() => onOpen(event)}
                        className="!text-xs"
                    >
                        Open {event.filename} in viewer
                    </TextButtonUI>
                </div>
            )}
        </div>
    );
}

/**
 * Media shown inline in an answer — images, video and audio, each a document
 * the panel can open. Adjacent images tile in a two-column grid on wide
 * screens; audio and video each take the full width with the browser's own
 * player.
 */
export function MediaBlock({ events, onOpenDocument }: MediaBlockProps) {
    if (events.length === 0) return null;
    const open = onOpenDocument
        ? (event: MediaEvent) =>
              onOpenDocument({
                  documentId: event.document_id,
                  filename: event.filename,
                  versionId: event.version_id,
                  versionNumber: event.version_number,
              })
        : undefined;

    // Split runs: a run of images becomes one grid, each audio/video stands
    // alone at full width with its controls.
    const runs: MediaEvent[][] = [];
    for (const event of events) {
        const last = runs.at(-1);
        if (event.kind === "image" && last && last.length > 0 && last[0].kind === "image") {
            last.push(event);
        } else {
            runs.push([event]);
        }
    }

    return (
        <div className="flex w-full flex-col gap-4">
            {runs.map((run, i) =>
                run.length > 1 ||
                (run.length === 1 && run[0].kind === "image") ? (
                    <div
                        key={i}
                        className={cn(
                            "grid w-full gap-3",
                            run.length > 1
                                ? "grid-cols-1 md:grid-cols-2"
                                : "grid-cols-1",
                        )}
                    >
                        {run.map((event, j) => (
                            <MediaImage
                                key={`${event.document_id}:${j}`}
                                event={event}
                                onOpen={open}
                            />
                        ))}
                    </div>
                ) : (
                    <MediaPlayer
                        key={`${run[0].document_id}:${i}`}
                        event={run[0]}
                        onOpen={open}
                    />
                ),
            )}
        </div>
    );
}
