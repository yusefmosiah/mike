"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    allowVaultWorkstation,
    deleteVaultSecret,
    getVaultStatus,
    getVaultWorkstation,
    listVaultActivity,
    listVaultSecrets,
    updateVaultSecret,
    type VaultActivityEvent,
    type VaultSecret,
    type VaultWorkstation,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { settingsGlassIconButtonClassName } from "../settingsStyles";

type Loaded = {
    enabled: boolean;
    secrets: VaultSecret[];
    activity: VaultActivityEvent[];
    workstation: VaultWorkstation | null;
};


const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function activityText(event: VaultActivityEvent): string {
    const name = event.secret_name ?? "a secret";
    switch (event.event) {
        case "created":
            return `Stored ${name}`;
        case "deleted":
            return `Deleted ${name}`;
        case "updated":
            return `Changed the settings of ${name}`;
        case "allowed":
            return "Allowed credentials in your workstation again";
        case "lease":
            return `Lent ${name} to the assistant (${event.access === "write" ? "changes allowed" : "read only"})`;
        case "request":
            return `${event.method} ${event.host}${event.path ?? ""} with ${name}${event.status ? `: ${event.status}` : ""}`;
        case "denied":
            return `Refused ${event.method ?? "a request"} to ${event.host ?? "a host"} with ${name}: ${event.reason ?? ""}`;
        default:
            return `${event.event} ${name}`;
    }
}

export default function VaultSettingsPage() {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const { enabled } = await getVaultStatus();
            if (!enabled) {
                setLoaded({ enabled, secrets: [], activity: [], workstation: null });
                return;
            }
            const [secrets, activity, workstation] = await Promise.all([
                listVaultSecrets(),
                listVaultActivity(30),
                // Secondary: the page still works if this cannot be read.
                getVaultWorkstation().catch(() => null),
            ]);
            setLoaded({ enabled, secrets, activity, workstation });
            setError(null);
        } catch (failure) {
            setError(userFacingApiError(failure, "The vault could not be loaded."));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const remove = async (secret: VaultSecret) => {
        setBusy(secret.id);
        try {
            await deleteVaultSecret(secret.id);
            setConfirmingDelete(null);
            await load();
        } catch (failure) {
            setError(userFacingApiError(failure, "The secret could not be deleted."));
        } finally {
            setBusy(null);
        }
    };

    const allowWorkstation = async () => {
        setBusy("workstation");
        try {
            await allowVaultWorkstation();
            await load();
        } catch (failure) {
            setError(userFacingApiError(failure, "Credentials could not be allowed again."));
        } finally {
            setBusy(null);
        }
    };

    const toggleWrites = async (secret: VaultSecret) => {
        setBusy(secret.id);
        try {
            await updateVaultSecret(secret.id, {
                writes: secret.writes === "allow" ? "ask" : "allow",
            });
            await load();
        } catch (failure) {
            setError(userFacingApiError(failure, "The setting could not be changed."));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <SettingsHeading>Vault</SettingsHeading>
                <SettingsDescription>
                    API keys, tokens and passwords the assistant can use without
                    seeing them. When a task needs one, the assistant asks for
                    it in the chat: you paste it into a secure field there, and
                    it goes straight to the vault on the server, which adds it
                    to requests only for the hosts shown. The assistant&apos;s
                    workstation never holds it.
                </SettingsDescription>
                {error && (
                    <p role="alert" className="text-sm text-red-600">
                        {error}
                    </p>
                )}
                {loaded?.workstation?.paused_since && (
                    <SettingsCard>
                        <SettingsRow layout="stacked">
                            <div className="space-y-2 text-sm">
                                <p className="font-medium text-gray-900">
                                    Paused in your workstation
                                </p>
                                <p className="text-gray-600">
                                    {loaded.workstation.guest_working
                                        ? "Someone else is working in your workstation right now."
                                        : `Someone else worked in your workstation (${when(loaded.workstation.paused_since)}).`}{" "}
                                    Anything they ran there could still be running, so the
                                    assistant cannot use your credentials in it until you allow
                                    them again.
                                </p>
                                <PillButtonUI
                                    tone="black"
                                    size="xs"
                                    onClick={() => void allowWorkstation()}
                                    loading={busy === "workstation"}
                                    disabled={loaded.workstation.guest_working}
                                >
                                    Allow again
                                </PillButtonUI>
                            </div>
                        </SettingsRow>
                    </SettingsCard>
                )}
                <SettingsCard>
                    {!loaded ? (
                        <div className="space-y-3 px-4 py-5" aria-hidden>
                            {[0, 1].map((row) => (
                                <div key={row} className="space-y-2">
                                    <div className="h-4 w-40 animate-pulse rounded bg-gray-100" />
                                    <div className="h-3 w-64 max-w-full animate-pulse rounded bg-gray-100" />
                                </div>
                            ))}
                        </div>
                    ) : !loaded.enabled ? (
                        <SettingsRow layout="stacked">
                            <p className="text-sm text-gray-500">
                                The vault is not set up on this server.
                            </p>
                        </SettingsRow>
                    ) : loaded.secrets.length === 0 ? (
                        <SettingsRow layout="stacked">
                            <p className="text-sm text-gray-500">
                                No secrets stored. The assistant asks for one
                                in the chat when a task needs it.
                            </p>
                        </SettingsRow>
                    ) : (
                        loaded.secrets.map((secret) => (
                            <SettingsRow key={secret.id} layout="stacked">
                                <div className="flex min-w-0 items-start justify-between gap-3">
                                    <div className="min-w-0 space-y-1 text-sm">
                                        <p className="font-medium break-words text-gray-900">
                                            {secret.name}
                                            {secret.hint && (
                                                <span className="ml-2 font-normal text-gray-400">
                                                    …{secret.hint}
                                                </span>
                                            )}
                                        </p>
                                        {secret.description && (
                                            <p className="break-words text-gray-600">{secret.description}</p>
                                        )}
                                        <p className="break-words text-gray-600">
                                            Sent only to {secret.hosts.join(", ")}
                                        </p>
                                        <p className="text-gray-500">
                                            {secret.last_used_at
                                                ? `Last used ${when(secret.last_used_at)}`
                                                : "Not used yet"}
                                        </p>
                                    </div>
                                    {confirmingDelete === secret.id ? (
                                        <div className="flex shrink-0 items-center gap-2">
                                            <PillButtonUI
                                                tone="white"
                                                size="xs"
                                                onClick={() => setConfirmingDelete(null)}
                                                disabled={busy === secret.id}
                                            >
                                                Keep
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="black"
                                                size="xs"
                                                onClick={() => void remove(secret)}
                                                loading={busy === secret.id}
                                            >
                                                Delete
                                            </PillButtonUI>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            aria-label={`Delete ${secret.name}`}
                                            onClick={() => setConfirmingDelete(secret.id)}
                                            className={`inline-flex h-8 shrink-0 items-center ${settingsGlassIconButtonClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400`}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                                <label className="flex items-center text-sm text-gray-700">
                                    <input
                                        type="checkbox"
                                        checked={secret.writes === "allow"}
                                        disabled={busy === secret.id}
                                        onChange={() => void toggleWrites(secret)}
                                        className={TABLE_CHECKBOX_CLASS}
                                    />
                                    Allow changes without asking each time
                                </label>
                            </SettingsRow>
                        ))
                    )}
                </SettingsCard>
            </section>

            {loaded?.enabled && loaded.activity.length > 0 && (
                <section className="space-y-3">
                    <SettingsHeading>Recent activity</SettingsHeading>
                    <SettingsCard>
                        <ul className="divide-y divide-gray-100">
                            {loaded.activity.map((event, index) => (
                                <li key={`${event.at}-${index}`} className="px-4 py-3 text-sm">
                                    <p className="break-words text-gray-800 [overflow-wrap:anywhere]">
                                        {activityText(event)}
                                    </p>
                                    <p className="text-xs text-gray-500">{when(event.at)}</p>
                                </li>
                            ))}
                        </ul>
                    </SettingsCard>
                </section>
            )}

        </div>
    );
}
