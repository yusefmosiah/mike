"use client";

import { useEffect, useId, useState } from "react";
import { Copy, ExternalLink, Globe, RefreshCw } from "lucide-react";
import { Modal } from "./Modal";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    createPublication,
    listPublications,
    revokePublication,
} from "@/app/lib/mikeApi";
import {
    EXPIRY_OPTIONS,
    MIN_PASSWORD_LENGTH,
    formatPublicationDate,
    generatePassphrase,
    publicationState,
    publishErrorMessage,
} from "@/app/lib/publishing";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type {
    Publication,
    PublicationAudience,
    PublishingConfig,
} from "@/app/components/shared/types";

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

const AUDIENCE_LABEL: Record<PublicationAudience, string> = {
    public: "Anyone with the link",
    password: "Anyone with the link and a password",
};

export function PublishModal(props: Props) {
    // Mounted only while open so each opening starts from a clean form.
    return props.open ? <PublishModalBody {...props} /> : null;
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
    const [audience, setAudience] = useState<PublicationAudience>(audiences[0] ?? "public");
    const [password, setPassword] = useState("");
    const [expiry, setExpiry] = useState("30");
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
    const passwordId = useId();
    const expiryLabelId = useId();
    const audienceLabelId = useId();

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

    const needsPassword = audience === "password";
    const passwordOk = !needsPassword || password.length >= MIN_PASSWORD_LENGTH;

    async function publish() {
        if (!passwordOk || publishing) return;
        setPublishing(true);
        setError(null);
        try {
            const created = await createPublication({
                document_id: target.documentId,
                version_id: target.versionId ?? null,
                audience,
                ...(needsPassword ? { password } : {}),
                expires_in_days: EXPIRY_OPTIONS.find((o) => o.value === expiry)!.days,
            });
            setResult({ ...created, password: needsPassword ? password : undefined });
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
                        {audience === "public"
                            ? "Anyone who has a public link can open it, with no sign-in, and the link may be shared onward. "
                            : "Anyone who has the link and its password can open it, with no sign-in. "}
                        This publishes this version as a frozen copy: later edits are not shared unless you publish again.
                    </p>

                    <div role="group" aria-labelledby={audienceLabelId}>
                        <FieldLabel as="p" id={audienceLabelId}>
                            Who can open it
                        </FieldLabel>
                        <ModalSegmentedToggle
                            value={audience}
                            onChange={setAudience}
                            options={audiences.map((value) => ({
                                value,
                                label: AUDIENCE_LABEL[value],
                                icon: Globe,
                            }))}
                            className="max-w-full"
                        />
                    </div>

                    {needsPassword && (
                        <div>
                            <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
                            <div className="flex items-center gap-2">
                                <FormTextInput
                                    id={passwordId}
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    aria-invalid={password.length > 0 && !passwordOk}
                                    className="min-w-0 flex-1"
                                />
                                <TextButtonUI type="button" onClick={() => setPassword(generatePassphrase())}>
                                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                    Generate
                                </TextButtonUI>
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">
                                At least {MIN_PASSWORD_LENGTH} characters. Send the password separately from the link.
                            </p>
                        </div>
                    )}

                    <div role="group" aria-labelledby={expiryLabelId}>
                        <FieldLabel as="p" id={expiryLabelId}>
                            Link expires
                        </FieldLabel>
                        <ModalSegmentedToggle
                            value={expiry}
                            onChange={setExpiry}
                            options={EXPIRY_OPTIONS.map(({ value, label }) => ({ value, label }))}
                            size="sm"
                        />
                    </div>

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
                                    <LinkRow key={link.id} link={link} onRevoke={() => setRevokeId(link.id)} />
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

function LinkRow({ link, onRevoke }: { link: Publication; onRevoke: () => void }) {
    const state = publicationState(link);
    return (
        <li className="space-y-1">
            <p className="text-xs font-medium text-gray-800">{AUDIENCE_LABEL[link.audience]}</p>
            <p className="text-xs text-gray-600">
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
                    <TextButtonUI type="button" onClick={onRevoke}>
                        Revoke
                    </TextButtonUI>
                )}
            </div>
        </li>
    );
}
