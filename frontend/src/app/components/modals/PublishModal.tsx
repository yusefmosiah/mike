"use client";

import { useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { Modal } from "./Modal";
import {
    AUDIENCE_LABEL,
    PublishOptionsForm,
    initialPublishOptions,
    publishOptionsToInput,
    publishOptionsValid,
    type PublishOptions,
} from "./PublishOptionsForm";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    createPublication,
    listPublications,
    revokePublication,
    updatePublication,
} from "@/app/lib/mikeApi";
import {
    formatPublicationDate,
    publicationState,
    publishErrorMessage,
} from "@/app/lib/publishing";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Publication, PublishingConfig } from "@/app/components/shared/types";

export interface PublishTarget {
    documentId: string;
    versionId?: string | null;
    filename: string;
}

interface Props {
    open: boolean;
    target: PublishTarget;
    config: PublishingConfig;
    onClose: () => void;
}

export function PublishModal(props: Props) {
    // Mounted only while open so each opening starts from a clean form.
    return props.open ? <PublishModalBody {...props} /> : null;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    return (
        <TextButtonUI
            type="button"
            aria-label={label}
            onClick={() => {
                void navigator.clipboard
                    .writeText(text)
                    .then(() => setState("copied"))
                    .catch(() => setState("failed"));
            }}
        >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </TextButtonUI>
    );
}

function PublishModalBody({ target, config, onClose }: Props) {
    const audiences = config.audiences;
    const [options, setOptions] = useState<PublishOptions>(() => initialPublishOptions(audiences));
    const [publishing, setPublishing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{
        publication: Publication;
        missing_files: string[];
        password?: string;
    } | null>(null);
    const [links, setLinks] = useState<Publication[] | null>(null);
    const [linksFailed, setLinksFailed] = useState(false);
    const [revokeId, setRevokeId] = useState<string | null>(null);
    const [revoking, setRevoking] = useState(false);

    useEffect(() => {
        let cancelled = false;
        listPublications(target.documentId)
            .then((list) => {
                if (!cancelled) setLinks(list);
            })
            .catch(() => {
                if (!cancelled) {
                    setLinks([]);
                    setLinksFailed(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [target.documentId]);

    const passwordOk = publishOptionsValid(options);

    async function publish() {
        if (!passwordOk || publishing) return;
        setPublishing(true);
        setError(null);
        try {
            const created = await createPublication(publishOptionsToInput(target, options));
            setResult({
                ...created,
                password: options.audience === "password" ? options.password : undefined,
            });
            setLinks((current) => [created.publication, ...(current ?? [])]);
        } catch (cause) {
            setError(publishErrorMessage(cause));
        } finally {
            setPublishing(false);
        }
    }

    async function revoke() {
        const id = revokeId;
        if (!id) return;
        setRevoking(true);
        try {
            const updated = await revokePublication(id);
            setLinks((current) => (current ?? []).map((p) => (p.id === id ? updated : p)));
            setResult((current) => (current?.publication.id === id ? null : current));
            setRevokeId(null);
        } catch (cause) {
            setRevokeId(null);
            setError(userFacingApiError(cause, "The link could not be revoked. Please try again."));
        } finally {
            setRevoking(false);
        }
    }

    return (
        <>
            <Modal
                open
                onClose={onClose}
                size="md"
                className="h-auto max-h-[calc(100vh-2rem)]"
                breadcrumbs={["Publish", target.filename]}
                cancelAction={{ label: "Done", onClick: onClose }}
                primaryAction={{
                    label: publishing ? "Publishing..." : "Publish",
                    type: "button",
                    onClick: () => void publish(),
                    disabled: !passwordOk || publishing,
                }}
            >
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4 pr-1">
                    <p className="text-xs leading-relaxed text-gray-600">
                        {options.requireSignIn
                            ? "Only people signed in to this app whose account can open the document can read it, even if the link is shared onward. "
                            : options.audience === "public"
                              ? "Anyone who has a public link can open it, with no sign-in, and the link may be shared onward. "
                              : "Anyone who has the link and its password can open it, with no sign-in. "}
                        {options.followDocument
                            ? "The link always shows the newest saved version of this document."
                            : "The link keeps a frozen copy of this version: later edits are not shared unless you publish again."}
                    </p>

                    <PublishOptionsForm
                        value={options}
                        onChange={setOptions}
                        audiences={audiences}
                        disabled={publishing}
                    />

                    {error && (
                        <p role="alert" className="text-xs text-red-600 [overflow-wrap:anywhere]">
                            {error}
                        </p>
                    )}

                    {result && (
                        <section aria-label="Published link" className="space-y-2">
                            <p className="text-sm font-medium text-gray-800">Published</p>
                            <p className="text-xs text-gray-700 [overflow-wrap:anywhere]">{result.publication.url}</p>
                            <div className="flex flex-wrap items-center gap-2">
                                <CopyButton text={result.publication.url ?? ""} label="Copy link" />
                                {result.password && <CopyButton text={result.password} label="Copy password" />}
                            </div>
                            {result.missing_files.length > 0 && (
                                <div role="status" className="text-xs text-amber-700">
                                    <p>
                                        These files are used by the page but were not found, so they will not load on the
                                        published page:
                                    </p>
                                    <ul className="mt-1 list-disc pl-4 [overflow-wrap:anywhere]">
                                        {result.missing_files.map((path) => (
                                            <li key={path}>{path}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </section>
                    )}

                    <section aria-label="Existing links">
                        <p className="mb-2 text-sm font-medium text-gray-700">Links for this document</p>
                        {links === null ? (
                            <div role="status" aria-label="Loading links" className="space-y-3">
                                <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200/70" />
                                <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200/70" />
                            </div>
                        ) : linksFailed ? (
                            <p role="alert" className="text-xs text-gray-600">
                                Existing links could not be loaded.
                            </p>
                        ) : links.length === 0 ? (
                            <p className="text-xs text-gray-500">No links yet.</p>
                        ) : (
                            <ul className="space-y-3">
                                {links.map((link) => (
                                    <LinkRow
                                        key={link.id}
                                        link={link}
                                        onRevoke={() => setRevokeId(link.id)}
                                        onUpdated={(updated) =>
                                            setLinks((current) =>
                                                (current ?? []).map((p) => (p.id === updated.id ? updated : p)),
                                            )
                                        }
                                    />
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
            </Modal>
            <ConfirmPopup
                open={revokeId !== null}
                title="Revoke this link?"
                message="Anyone who has it will no longer be able to open it. This cannot be undone."
                confirmLabel="Revoke"
                confirmVariant="danger"
                confirmStatus={revoking ? "loading" : "idle"}
                onConfirm={() => void revoke()}
                onCancel={() => setRevokeId(null)}
            />
        </>
    );
}

function LinkRow({
    link,
    onRevoke,
    onUpdated,
}: {
    link: Publication;
    onRevoke: () => void;
    onUpdated: (link: Publication) => void;
}) {
    const state = publicationState(link);
    const [saving, setSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    async function patch(input: Parameters<typeof updatePublication>[1]) {
        setSaving(true);
        setEditError(null);
        try {
            onUpdated(await updatePublication(link.id, input));
        } catch (cause) {
            setEditError(userFacingApiError(cause, "The link could not be updated. Please try again."));
        } finally {
            setSaving(false);
        }
    }

    return (
        <li className="space-y-1">
            <p className="text-xs font-medium text-gray-800">{AUDIENCE_LABEL[link.audience]}</p>
            {link.require_sign_in && <p className="text-xs text-gray-600">Signed in only</p>}
            <p className="text-xs text-gray-600">
                {link.follow_document ? "Follows the latest version" : "Frozen copy"}
                {" · "}
                Created {formatPublicationDate(link.created_at)}
                {" · "}
                {state === "revoked"
                    ? "Revoked"
                    : state === "expired"
                      ? "Expired"
                      : link.expires_at
                        ? `Expires ${formatPublicationDate(link.expires_at)}`
                        : "Never expires"}
            </p>
            {link.url && state === "active" && (
                <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{link.url}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {link.url && state === "active" && (
                    <>
                        <CopyButton text={link.url} label={`Copy link created ${formatPublicationDate(link.created_at)}`} />
                        <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded px-1 text-xs text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            Open
                        </a>
                    </>
                )}
                {state === "active" && (
                    <>
                        <TextButtonUI
                            type="button"
                            disabled={saving}
                            onClick={() => void patch({ follow_document: !link.follow_document })}
                        >
                            {link.follow_document ? "Freeze this version" : "Follow latest"}
                        </TextButtonUI>
                        {link.expires_at && (
                            <TextButtonUI
                                type="button"
                                disabled={saving}
                                onClick={() => void patch({ expires_in_days: null })}
                            >
                                Remove expiry
                            </TextButtonUI>
                        )}
                        {!link.expires_at && (
                            <TextButtonUI
                                type="button"
                                disabled={saving}
                                onClick={() => void patch({ expires_in_days: 30 })}
                            >
                                Expire in 30 days
                            </TextButtonUI>
                        )}
                        <TextButtonUI type="button" onClick={onRevoke}>
                            Revoke
                        </TextButtonUI>
                    </>
                )}
            </div>
            {editError && (
                <p role="alert" className="text-xs text-red-600 [overflow-wrap:anywhere]">
                    {editError}
                </p>
            )}
        </li>
    );
}
