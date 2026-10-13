"use client";

import { useId, useState } from "react";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Modal } from "../modals/Modal";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { TABLE_CHECKBOX_CLASS } from "../shared/TablePrimitive";
import {
    storeVaultSecret,
    type VaultInjection,
    type VaultSecret,
} from "@/app/lib/mikeApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { VaultKeyMismatchError } from "@/app/lib/vault/seal";

/** What the assistant suggested; every field stays the user's to change. */
export type VaultSecretDraft = {
    name: string;
    hosts: string[];
    injection: VaultInjection;
    /** The assistant's stated reason, shown as its words. */
    purpose?: string;
};

type AuthKind = VaultInjection["type"];

interface VaultSecretModalProps {
    open: boolean;
    onClose: () => void;
    onSaved: (secret: VaultSecret) => void;
    draft?: VaultSecretDraft;
}

export function VaultSecretModal(props: VaultSecretModalProps) {
    // Mounted only while open: the value never outlives the form.
    return props.open ? <VaultSecretForm {...props} /> : null;
}

const AUTH_OPTIONS: { value: AuthKind; label: string }[] = [
    { value: "bearer", label: "Bearer token" },
    { value: "basic", label: "Username + token" },
    { value: "header", label: "Custom header" },
];

/** As the vault stores a host: lowercase, no scheme, path or trailing dot. */
const canonicalHost = (host: string) =>
    host
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/\.+$/, "");

const parseHosts = (text: string) =>
    text
        .split(/[\s,]+/)
        .map(canonicalHost)
        .filter(Boolean);

function VaultSecretForm({ open, onClose, onSaved, draft }: VaultSecretModalProps) {
    const id = useId();
    const formId = `${id}-form`;
    const { user } = useAuth();
    const [name, setName] = useState(draft?.name ?? "");
    const [value, setValue] = useState("");
    const [showValue, setShowValue] = useState(false);
    const [hosts, setHosts] = useState(draft?.hosts.join(", ") ?? "");
    const [auth, setAuth] = useState<AuthKind>(draft?.injection.type ?? "bearer");
    const [username, setUsername] = useState(
        draft?.injection.type === "basic" ? draft.injection.username : "",
    );
    const [header, setHeader] = useState(
        draft?.injection.type === "header" ? draft.injection.name : "",
    );
    const [allowWrites, setAllowWrites] = useState(false);
    const [hostsChecked, setHostsChecked] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const hostList = parseHosts(hosts);
    const injection: VaultInjection | null =
        auth === "bearer"
            ? { type: "bearer" }
            : auth === "basic"
              ? username.trim()
                  ? { type: "basic", username: username.trim() }
                  : null
              : header.trim()
                ? { type: "header", name: header.trim() }
                : null;
    // Hosts the assistant proposed, still in the list: a prompt-injected
    // assistant would propose its own, so the user confirms them explicitly.
    const suggested = new Set(draft?.hosts.map(canonicalHost) ?? []);
    const suggestedHosts = hostList.filter((host) => suggested.has(host));
    const ready =
        !!user &&
        !!name.trim() &&
        value.length >= 8 &&
        hostList.length > 0 &&
        !!injection &&
        (suggestedHosts.length === 0 || hostsChecked) &&
        !saving;

    const save = async () => {
        if (!ready || !injection || !user) return;
        setSaving(true);
        setError(null);
        try {
            const secret = await storeVaultSecret(
                {
                    name: name.trim().toLowerCase(),
                    hosts: hostList,
                    injection,
                    writes: allowWrites ? "allow" : "ask",
                },
                value,
                user.id,
            );
            setValue("");
            onSaved(secret);
        } catch (failure) {
            setError(
                failure instanceof VaultKeyMismatchError
                    ? "The vault could not be verified, so nothing was sent. Contact your administrator."
                    : userFacingApiError(failure, "The secret could not be stored. Try again."),
            );
            setSaving(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="md"
            className="h-auto max-h-[calc(100vh-2rem)]"
            breadcrumbs={["Vault", "Store a secret"]}
            footerStatus={
                error ? (
                    <p role="alert" className="text-sm text-red-600">
                        {error}
                    </p>
                ) : undefined
            }
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
            primaryAction={{
                label: saving ? "Storing..." : "Store in vault",
                type: "submit",
                form: formId,
                disabled: !ready,
            }}
        >
            <form
                id={formId}
                className="space-y-5"
                autoComplete="off"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <p className="flex gap-2 text-sm text-gray-600">
                    <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                    <span>
                        The value is encrypted in this browser for the vault on the server.
                        The assistant never sees it, and it can never be shown again.
                    </span>
                </p>
                {draft?.purpose && (
                    <div className="text-sm text-gray-600">
                        <p className="font-medium text-gray-700">The assistant asked for it to</p>
                        <p className="mt-1 whitespace-pre-wrap break-words">{draft.purpose}</p>
                    </div>
                )}
                <div>
                    <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                    <FormTextInput
                        id={`${id}-name`}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="e.g. github-deploy"
                        maxLength={63}
                        spellCheck={false}
                    />
                </div>
                <div>
                    <FieldLabel htmlFor={`${id}-value`}>Secret</FieldLabel>
                    <div className="relative">
                        <FormTextInput
                            id={`${id}-value`}
                            type={showValue ? "text" : "password"}
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            autoComplete="new-password"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            data-sentry-mask
                            className="pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowValue((shown) => !shown)}
                            aria-label={showValue ? "Hide secret" : "Show secret"}
                            aria-pressed={showValue}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                        >
                            {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                </div>
                <div>
                    <FieldLabel htmlFor={`${id}-hosts`}>Where it may be sent</FieldLabel>
                    <FormTextInput
                        id={`${id}-hosts`}
                        value={hosts}
                        onChange={(event) => setHosts(event.target.value)}
                        placeholder="api.example.com"
                        spellCheck={false}
                        aria-describedby={`${id}-hosts-help`}
                    />
                    <p id={`${id}-hosts-help`} className="mt-1.5 text-xs text-gray-500">
                        Exact host names, separated by commas. HTTPS only. It can never be
                        sent anywhere else: to change this, store it again.
                    </p>
                    {suggestedHosts.length > 0 && (
                        <label className="mt-3 flex items-start text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={hostsChecked}
                                onChange={(event) => setHostsChecked(event.target.checked)}
                                className={`${TABLE_CHECKBOX_CLASS} mt-1.5`}
                            />
                            <span>
                                The assistant suggested{" "}
                                <span className="font-medium break-all">
                                    {suggestedHosts.join(", ")}
                                </span>
                                . I checked that {suggestedHosts.length === 1 ? "it belongs" : "they belong"}{" "}
                                to the service this secret is for.
                            </span>
                        </label>
                    )}
                </div>
                <div>
                    <FieldLabel as="p" id={`${id}-auth`}>How the service takes it</FieldLabel>
                    <div aria-labelledby={`${id}-auth`} role="group">
                        <ModalSegmentedToggle value={auth} onChange={setAuth} options={AUTH_OPTIONS} size="sm" />
                    </div>
                    {auth === "basic" && (
                        <div className="mt-3">
                            <FieldLabel htmlFor={`${id}-username`}>Username</FieldLabel>
                            <FormTextInput
                                id={`${id}-username`}
                                value={username}
                                onChange={(event) => setUsername(event.target.value)}
                                spellCheck={false}
                            />
                        </div>
                    )}
                    {auth === "header" && (
                        <div className="mt-3">
                            <FieldLabel htmlFor={`${id}-header`}>Header name</FieldLabel>
                            <FormTextInput
                                id={`${id}-header`}
                                value={header}
                                onChange={(event) => setHeader(event.target.value)}
                                placeholder="X-API-Key"
                                spellCheck={false}
                            />
                        </div>
                    )}
                </div>
                <label className="flex items-start text-sm text-gray-700">
                    <input
                        type="checkbox"
                        checked={allowWrites}
                        onChange={(event) => setAllowWrites(event.target.checked)}
                        className={`${TABLE_CHECKBOX_CLASS} mt-1.5`}
                    />
                    <span>
                        Let the assistant make changes with it without asking each time
                        <span className="block text-xs text-gray-500">
                            Reading (GET requests) is always allowed. Changes (sending, pushing,
                            deleting) ask for your approval unless this is on. A service that
                            changes things on a read is not stopped by this.
                        </span>
                    </span>
                </label>
            </form>
        </Modal>
    );
}
