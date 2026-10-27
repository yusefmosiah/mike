"use client";

import { useDocumentFileUrl } from "@/app/hooks/useDocumentFileUrl";
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
    const { url, failed } = useDocumentFileUrl(documentId, versionId, refetchKey);
    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 items-center justify-center overflow-auto bg-app-background p-4",
                rounded === true && "rounded-xl",
                rounded === "top-right" && "rounded-tr-xl",
            )}
        >
            {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- an authenticated blob URL, not an optimisable asset
                <img src={url} alt={filename} className="max-h-full max-w-full object-contain" />
            ) : failed ? (
                <p role="alert" className="text-sm text-gray-600">
                    The image could not be loaded.
                </p>
            ) : (
                <div aria-label="Loading image" role="status" className="h-2/3 w-2/3 animate-pulse rounded-lg bg-gray-200/70" />
            )}
        </div>
    );
}
