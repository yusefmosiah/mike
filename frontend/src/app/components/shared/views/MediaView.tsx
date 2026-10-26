"use client";

import { useState } from "react";
import { API_BASE } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

interface Props {
    documentId: string;
    versionId?: string | null;
    filename: string;
    kind: "audio" | "video";
    refetchKey?: number | string;
    rounded?: boolean | "top-right";
}

/**
 * An audio or video document, in the browser's own player. The player reads
 * /file directly (the session cookie goes with it) in byte ranges, so it
 * starts at once and can seek without downloading the whole file.
 */
export function MediaView({ documentId, versionId, filename, kind, refetchKey, rounded = true }: Props) {
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    // A new key after an edit makes the player load the new bytes.
    if (refetchKey !== undefined && refetchKey !== "") params.set("r", String(refetchKey));
    const qs = params.size ? `?${params.toString()}` : "";
    const src = `${API_BASE}/single-documents/${documentId}/file${qs}`;
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const failed = failedSrc === src;

    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-app-background p-4",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {failed ? (
                <p role="alert" className="text-sm text-gray-600">
                    {kind === "video" ? "The video could not be played." : "The audio could not be played."}
                </p>
            ) : kind === "video" ? (
                <video
                    key={src}
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={filename}
                    onError={() => setFailedSrc(src)}
                    className="max-h-full max-w-full rounded-lg bg-black"
                />
            ) : (
                <>
                    <p className="max-w-full break-words text-center text-sm text-gray-700">{filename}</p>
                    <audio
                        key={src}
                        src={src}
                        controls
                        preload="metadata"
                        aria-label={filename}
                        onError={() => setFailedSrc(src)}
                        className="w-full max-w-xl"
                    />
                </>
            )}
        </div>
    );
}
