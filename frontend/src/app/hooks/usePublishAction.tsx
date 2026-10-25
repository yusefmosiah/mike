"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PublishModal, type PublishTarget } from "@/app/components/modals/PublishModal";
import type { PublishingConfig } from "@/app/components/shared/types";
import { getPublishingConfig } from "@/app/lib/mikeApi";
import { isPublishable } from "@/app/lib/publishing";

/**
 * Publish-as-link for the document viewer. `publishAction(target)` gives the
 * `onPublish` callback for a tab, or undefined when publishing is off on this
 * install or the file type cannot be published; render `publishModal` once.
 */
export function usePublishAction(): {
    publishAction: (target: PublishTarget & { fileType?: string | null }) => (() => void) | undefined;
    publishModal: ReactNode;
} {
    const [config, setConfig] = useState<PublishingConfig | null>(null);
    const [target, setTarget] = useState<PublishTarget | null>(null);

    useEffect(() => {
        let cancelled = false;
        getPublishingConfig()
            .then((value) => {
                if (!cancelled) setConfig(value);
            })
            .catch(() => {
                // No config means no Publish action; nothing to tell the reader.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const enabled = !!config?.enabled && config.audiences.length > 0;
    const publishAction = useCallback(
        (value: PublishTarget & { fileType?: string | null }) =>
            enabled && isPublishable(value.filename, value.fileType)
                ? () =>
                      setTarget({
                          documentId: value.documentId,
                          versionId: value.versionId,
                          filename: value.filename,
                      })
                : undefined,
        [enabled],
    );

    return {
        publishAction,
        publishModal:
            config && target ? (
                <PublishModal open target={target} config={config} onClose={() => setTarget(null)} />
            ) : null,
    };
}
