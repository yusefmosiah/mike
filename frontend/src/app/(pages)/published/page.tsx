"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EmptyState } from "@/app/components/ui/empty-state";
import { MikeApiError, openPublication } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_AVAILABLE =
    "This page isn't available to this account. You may need to sign in with a different account, or ask the person who shared it.";

/**
 * Where the content server sends visitors of a signed-in-only link. The app
 * layout has already made them sign in and brought them back here; this asks
 * the API for the address to read it at and goes there.
 */
export default function PublishedPage() {
    const searchParams = useSearchParams();
    const publicationId = searchParams.get("p") ?? "";
    const path = searchParams.get("r") ?? undefined;
    const valid = UUID.test(publicationId);
    const [failure, setFailure] = useState<string | null>(null);

    useEffect(() => {
        if (!valid) return;
        let cancelled = false;
        openPublication(publicationId, path)
            .then(({ url }) => {
                if (!cancelled) window.location.replace(url);
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setFailure(
                    cause instanceof MikeApiError && cause.status === 404
                        ? NOT_AVAILABLE
                        : userFacingApiError(cause, "The page could not be opened. Please try again."),
                );
            });
        return () => {
            cancelled = true;
        };
    }, [valid, publicationId, path]);

    const message = !valid ? NOT_AVAILABLE : failure;
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            {message ? (
                <EmptyState title="Page not available" description={message} tone="error" />
            ) : (
                <p role="status" className="text-sm text-gray-600">
                    Opening…
                </p>
            )}
        </div>
    );
}
