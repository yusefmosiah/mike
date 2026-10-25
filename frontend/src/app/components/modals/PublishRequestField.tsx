"use client";

import { useEffect, useState } from "react";
import { Check, FileText } from "lucide-react";
import type { AskInputItem } from "@mike/contracts";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { CopyButton } from "./PublishModal";
import {
    PublishOptionsForm,
    initialPublishOptions,
    publishOptionsToInput,
    publishOptionsValid,
    type PublishOptions,
} from "./PublishOptionsForm";
import { createPublication, getPublishingConfig } from "@/app/lib/mikeApi";
import { publishErrorMessage } from "@/app/lib/publishing";
import type { Publication, PublishingConfig } from "@/app/components/shared/types";

type PublishRequestItem = Extract<AskInputItem, { kind: "publish" }>;

export interface PublishedLink {
    publication: Publication;
    /** Kept in this browser only, to offer Copy password; never sent anywhere else. */
    password?: string;
}

/**
 * The assistant's request to publish a document as a link, in the chat. Its
 * choices are only suggestions the person can change; the link is created
 * here, so the password never enters the conversation, and only the
 * publication's id is reported back.
 */
export function PublishRequestField({
    item,
    published,
    disabled,
    onPublished,
}: {
    item: PublishRequestItem;
    /** Set once published: the form is replaced by the link. */
    published?: PublishedLink;
    disabled?: boolean;
    onPublished: (link: PublishedLink) => void;
}) {
    const [config, setConfig] = useState<PublishingConfig | null>(null);
    const [configFailed, setConfigFailed] = useState(false);
    const [options, setOptions] = useState<PublishOptions | null>(null);
    const [publishing, setPublishing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const done = !!published;
    useEffect(() => {
        if (done) return;
        let cancelled = false;
        getPublishingConfig()
            .then((value) => {
                if (cancelled) return;
                setConfig(value);
                setOptions(initialPublishOptions(value.audiences, item));
            })
            .catch(() => {
                if (!cancelled) setConfigFailed(true);
            });
        return () => {
            cancelled = true;
        };
        // The suggestions seed the form once; later edits are the person's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.id, done]);

    const available = !!config?.enabled && config.audiences.length > 0;
    const ready = available && !!options && publishOptionsValid(options) && !publishing && !disabled;

    const publish = async () => {
        if (!ready || !options) return;
        setPublishing(true);
        setError(null);
        try {
            const created = await createPublication(
                publishOptionsToInput(
                    { documentId: item.document_id, versionId: item.version_id },
                    options,
                ),
            );
            onPublished({
                publication: created.publication,
                password: options.audience === "password" ? options.password : undefined,
            });
        } catch (failure) {
            setError(publishErrorMessage(failure));
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="space-y-3 font-sans text-sm">
            <p className="flex items-start gap-2 text-gray-800">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                <span className="font-medium [overflow-wrap:anywhere]">{item.filename}</span>
            </p>
            {item.purpose && (
                <p className="whitespace-pre-wrap text-gray-700 [overflow-wrap:anywhere]">{item.purpose}</p>
            )}
            {published ? (
                <section aria-label="Published link" className="space-y-2">
                    <p className="flex items-center gap-1.5 text-gray-700">
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Published
                    </p>
                    <p className="text-xs text-gray-700 [overflow-wrap:anywhere]">{published.publication.url}</p>
                    <div className="flex flex-wrap items-center gap-2">
                        <CopyButton text={published.publication.url ?? ""} label="Copy link" />
                        {published.password && <CopyButton text={published.password} label="Copy password" />}
                    </div>
                </section>
            ) : configFailed || (config && !available) ? (
                <p role="status" className="text-gray-600">
                    Publishing is not available right now.
                </p>
            ) : !config || !options ? (
                <div role="status" aria-label="Loading publishing options" className="space-y-3">
                    <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200/70" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200/70" />
                </div>
            ) : (
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void publish();
                    }}
                >
                    <p className="text-xs text-gray-600">
                        This publishes this version as a frozen copy. The password, if any, is not shared with the
                        agent.
                    </p>
                    <PublishOptionsForm
                        value={options}
                        onChange={setOptions}
                        audiences={config.audiences}
                        disabled={disabled || publishing}
                    />
                    {error && (
                        <p role="alert" className="text-xs text-red-600 [overflow-wrap:anywhere]">
                            {error}
                        </p>
                    )}
                    <PillButtonUI
                        tone="black"
                        size="xs"
                        type="submit"
                        disabled={!ready}
                        loading={publishing}
                        className="max-w-full font-sans"
                    >
                        Publish
                    </PillButtonUI>
                </form>
            )}
        </div>
    );
}
