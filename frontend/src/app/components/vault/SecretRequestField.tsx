"use client";

import { useId, useState } from "react";
import { Check, Eye, EyeOff, LockKeyhole } from "lucide-react";
import type { AskInputItem } from "@mike/contracts";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useAuth } from "@/app/contexts/AuthContext";
import { storeVaultSecret, type VaultSecret } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { VaultKeyMismatchError } from "@/app/lib/vault/seal";

type SecretRequestItem = Extract<AskInputItem, { kind: "secret" }>;

/**
 * The assistant's request for a credential, in the chat. The assistant has
 * chosen everything else; the person only pastes the value, which is sealed
 * in this browser for the vault and never enters the conversation. The
 * button names where it may be sent, which is what the person confirms.
 */
export function SecretRequestField({
    item,
    storedName,
    disabled,
    onStored,
}: {
    item: SecretRequestItem;
    /** Set once stored: the field is replaced by a note. */
    storedName?: string;
    disabled?: boolean;
    onStored: (secret: VaultSecret) => void;
}) {
    const id = useId();
    const { user } = useAuth();
    const [value, setValue] = useState("");
    const [shown, setShown] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hosts = item.hosts.join(", ");
    // How it is attached, when it is not the usual bearer token: the
    // assistant chose it, so the person sees it.
    const attached =
        item.injection.type === "basic"
            ? ` As basic auth with the username ${item.injection.username}.`
            : item.injection.type === "header"
              ? ` In the ${item.injection.name} header.`
              : "";
    const ready = !!user && value.length >= 8 && !saving && !disabled;

    const store = async () => {
        if (!ready || !user) return;
        setSaving(true);
        setError(null);
        try {
            const secret = await storeVaultSecret(
                {
                    name: item.name,
                    hosts: item.hosts,
                    injection: item.injection,
                    writes: "ask",
                    ...(item.replaces ? { replaces: item.replaces } : {}),
                },
                value,
                user.id,
            );
            setValue("");
            onStored(secret);
        } catch (failure) {
            setError(
                failure instanceof VaultKeyMismatchError
                    ? "The vault could not be verified, so nothing was sent. Contact your administrator."
                    : userFacingApiError(failure, "It could not be stored. Try again."),
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-3 font-sans text-sm">
            {item.purpose && (
                <p className="whitespace-pre-wrap break-words text-gray-700">{item.purpose}</p>
            )}
            <p className="flex gap-2 text-gray-600">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                <span>
                    {item.replaces ? `Replaces the stored ${item.name}. ` : ""}
                    Sent only to <span className="font-medium break-all text-gray-800">{hosts}</span>.
                    {attached} The assistant never sees it.
                </span>
            </p>
            {storedName ? (
                <p className="flex items-center gap-1.5 text-gray-700">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    Stored as {storedName}
                </p>
            ) : (
                <form
                    className="space-y-2"
                    autoComplete="off"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void store();
                    }}
                >
                    <div className="relative">
                        <label htmlFor={`${id}-secret`} className="sr-only">
                            Secret
                        </label>
                        <input
                            id={`${id}-secret`}
                            type={shown ? "text" : "password"}
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            disabled={disabled || saving}
                            placeholder="Paste the secret"
                            autoComplete="new-password"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            data-sentry-mask
                            className="w-full rounded-lg bg-gray-100/70 py-2 pl-3 pr-10 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:bg-gray-200/70 focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-60"
                        />
                        <button
                            type="button"
                            onClick={() => setShown((was) => !was)}
                            aria-label={shown ? "Hide secret" : "Show secret"}
                            aria-pressed={shown}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                        >
                            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                    {error && (
                        <p role="alert" className="text-sm text-red-600">
                            {error}
                        </p>
                    )}
                    <PillButtonUI
                        tone="black"
                        size="xs"
                        type="submit"
                        disabled={!ready}
                        loading={saving}
                        className="max-w-full font-sans"
                    >
                        <span className="break-all">Store for {hosts}</span>
                    </PillButtonUI>
                </form>
            )}
        </div>
    );
}
