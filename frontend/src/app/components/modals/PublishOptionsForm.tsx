"use client";

import { useId } from "react";
import { Globe, Lock, RefreshCw } from "lucide-react";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import {
    EXPIRY_OPTIONS,
    MIN_PASSWORD_LENGTH,
    generatePassphrase,
} from "@/app/lib/publishing";
import type {
    CreatePublicationInput,
    PublicationAudience,
} from "@/app/components/shared/types";

/** What the person chooses for a link; shared by the modal and the chat card. */
export interface PublishOptions {
    audience: PublicationAudience;
    password: string;
    requireSignIn: boolean;
    /** A value of `EXPIRY_OPTIONS`. */
    expiry: string;
    /** Serve the current version (true) or freeze a copy now (false). */
    followDocument: boolean;
}

export const AUDIENCE_LABEL: Record<PublicationAudience, string> = {
    public: "Anyone with the link",
    password: "Anyone with the link and a password",
};

/** The audience choices: short enough to sit side by side on a phone. */
const AUDIENCE_OPTION: Record<PublicationAudience, { label: string; icon: typeof Globe }> = {
    public: { label: "Anyone with the link", icon: Globe },
    password: { label: "With a password", icon: Lock },
};

/** Options to start from; a suggestion the install cannot honour is dropped. */
export function initialPublishOptions(
    audiences: PublicationAudience[],
    suggestion?: {
        audience?: PublicationAudience;
        require_sign_in?: boolean;
        expires_in_days?: number | null;
        follow_document?: boolean;
    },
): PublishOptions {
    const audience =
        suggestion?.audience && audiences.includes(suggestion.audience)
            ? suggestion.audience
            : (audiences[0] ?? "public");
    const expiry =
        suggestion?.expires_in_days === undefined
            ? undefined
            : EXPIRY_OPTIONS.find((o) => o.days === suggestion.expires_in_days);
    return {
        audience,
        password: "",
        requireSignIn: suggestion?.require_sign_in ?? false,
        expiry: expiry?.value ?? "30",
        followDocument: suggestion?.follow_document ?? true,
    };
}

export function publishOptionsValid(options: PublishOptions): boolean {
    return (
        options.audience !== "password" ||
        options.password.length >= MIN_PASSWORD_LENGTH
    );
}

export function publishOptionsToInput(
    target: { documentId: string; versionId?: string | null },
    options: PublishOptions,
): CreatePublicationInput {
    return {
        document_id: target.documentId,
        version_id: target.versionId ?? null,
        audience: options.audience,
        ...(options.audience === "password" ? { password: options.password } : {}),
        ...(options.requireSignIn ? { require_sign_in: true } : {}),
        expires_in_days: EXPIRY_OPTIONS.find((o) => o.value === options.expiry)!.days,
        follow_document: options.followDocument,
    };
}

export function PublishOptionsForm({
    value,
    onChange,
    audiences,
    disabled,
}: {
    value: PublishOptions;
    onChange: (next: PublishOptions) => void;
    audiences: PublicationAudience[];
    disabled?: boolean;
}) {
    const passwordId = useId();
    const expiryLabelId = useId();
    const audienceLabelId = useId();
    const needsPassword = value.audience === "password";
    const passwordOk = publishOptionsValid(value);
    const set = (patch: Partial<PublishOptions>) => onChange({ ...value, ...patch });

    return (
        <div className="space-y-4">
            <div role="group" aria-labelledby={audienceLabelId}>
                <FieldLabel as="p" id={audienceLabelId}>
                    Who can open it
                </FieldLabel>
                <ModalSegmentedToggle
                    value={value.audience}
                    onChange={(audience) => set({ audience })}
                    options={audiences.map((audience) => ({
                        value: audience,
                        ...AUDIENCE_OPTION[audience],
                    }))}
                    disabled={disabled}
                    className="w-full"
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
                            value={value.password}
                            disabled={disabled}
                            onChange={(event) => set({ password: event.target.value })}
                            aria-invalid={value.password.length > 0 && !passwordOk}
                            className="min-w-0 flex-1"
                        />
                        <TextButtonUI
                            type="button"
                            disabled={disabled}
                            onClick={() => set({ password: generatePassphrase() })}
                        >
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                            Generate
                        </TextButtonUI>
                    </div>
                    <p className="mt-1.5 text-xs text-gray-500">
                        At least {MIN_PASSWORD_LENGTH} characters. Send it separately from the link.
                    </p>
                </div>
            )}

            <div>
                <ToggleSwitchUI
                    checked={value.requireSignIn}
                    disabled={disabled}
                    onCheckedChange={(requireSignIn) => set({ requireSignIn })}
                >
                    Signed-in members only
                </ToggleSwitchUI>
                <p className="mt-1.5 text-xs text-gray-500">
                    Visitors sign in and need access to this document.
                </p>
            </div>

            <div role="group" aria-labelledby={expiryLabelId}>
                <FieldLabel as="p" id={expiryLabelId}>
                    Link expires
                </FieldLabel>
                <ModalSegmentedToggle
                    value={value.expiry}
                    onChange={(expiry) => set({ expiry })}
                    options={EXPIRY_OPTIONS.map(({ value: v, label }) => ({ value: v, label }))}
                    disabled={disabled}
                    size="sm"
                    className="w-full"
                />
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-0.5 text-xs text-gray-500">
                <span>
                    {value.followDocument
                        ? "Saved changes update this link automatically."
                        : "Frozen copy of this version — later edits are not shared."}
                </span>
                <TextButtonUI
                    type="button"
                    size="xs"
                    disabled={disabled}
                    onClick={() => set({ followDocument: !value.followDocument })}
                >
                    {value.followDocument
                        ? "Freeze this version instead"
                        : "Update automatically instead"}
                </TextButtonUI>
            </div>
        </div>
    );
}
