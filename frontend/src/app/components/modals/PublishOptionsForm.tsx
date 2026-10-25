"use client";

import { useId } from "react";
import { Globe, RefreshCw } from "lucide-react";
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
}

export const AUDIENCE_LABEL: Record<PublicationAudience, string> = {
    public: "Anyone with the link",
    password: "Anyone with the link and a password",
};

/** Options to start from; a suggestion the install cannot honour is dropped. */
export function initialPublishOptions(
    audiences: PublicationAudience[],
    suggestion?: {
        audience?: PublicationAudience;
        require_sign_in?: boolean;
        expires_in_days?: number | null;
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
        <div className="space-y-5">
            <div role="group" aria-labelledby={audienceLabelId}>
                <FieldLabel as="p" id={audienceLabelId}>
                    Who can open it
                </FieldLabel>
                <ModalSegmentedToggle
                    value={value.audience}
                    onChange={(audience) => set({ audience })}
                    options={audiences.map((audience) => ({
                        value: audience,
                        label: AUDIENCE_LABEL[audience],
                        icon: Globe,
                    }))}
                    disabled={disabled}
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
                        At least {MIN_PASSWORD_LENGTH} characters. Send the password separately from the link.
                    </p>
                </div>
            )}

            <div>
                <ToggleSwitchUI
                    checked={value.requireSignIn}
                    disabled={disabled}
                    onCheckedChange={(requireSignIn) => set({ requireSignIn })}
                >
                    Only people signed in who can open this document
                </ToggleSwitchUI>
                <p className="mt-1.5 text-xs text-gray-500">
                    Visitors will be asked to sign in, and can read it only if their account can open the original
                    document.
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
                />
            </div>
        </div>
    );
}
