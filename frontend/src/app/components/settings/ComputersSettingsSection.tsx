"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerDevice, CreatedComputerDevice } from "@mike/contracts";
import { Copy } from "lucide-react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  API_BASE,
  createComputer,
  listComputers,
  revokeComputer,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "./SettingsCard";
import { SettingsHeading } from "./SettingsHeading";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { SETTINGS_CONTROL_CLASS, SettingsTextInput } from "./SettingsTextInput";

const REFRESH_MS = 15_000;
const DEFAULT_NAME = "My Mac";

export function lastSeenText(device: ComputerDevice, now = Date.now()) {
  if (device.online) return "Online";
  if (!device.last_seen_at) return "Never connected";
  const seconds = Math.max(
    0,
    Math.round((now - new Date(device.last_seen_at).getTime()) / 1000),
  );
  if (seconds < 60) return "Last seen just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Last seen ${days} day${days === 1 ? "" : "s"} ago`;
}

const PLATFORM_LABELS: Record<NonNullable<ComputerDevice["platform"]>, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  sandbox: "Sandboxed desktop",
};

export function platformText(device: ComputerDevice) {
  return device.platform ? PLATFORM_LABELS[device.platform] : null;
}

function ComputersSkeleton() {
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-5"
      aria-hidden="true"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-4 w-36 animate-pulse rounded bg-gray-100" />
        <div className="h-3 w-24 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-9 w-20 shrink-0 animate-pulse rounded-lg bg-gray-100" />
    </div>
  );
}

export function ComputersSettingsSection() {
  const [devices, setDevices] = useState<ComputerDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedComputerDevice | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ComputerDevice | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);
  const mounted = useRef(true);
  // The browser's own origin, known only once mounted.
  const [serverAddress, setServerAddress] = useState(API_BASE);

  const refresh = useCallback(async () => {
    try {
      const next = await listComputers();
      if (!mounted.current) return;
      setDevices(next);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setDevices((current) => current ?? []);
      setError(userFacingApiError(err, "Computers could not be loaded."));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setServerAddress(`${window.location.origin}${API_BASE}`);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createComputer(trimmed);
      setCreated(result);
      setCopied(false);
      setName(DEFAULT_NAME);
      await refresh();
    } catch (err) {
      setError(userFacingApiError(err, "The computer could not be added."));
    } finally {
      setCreating(false);
    }
  }

  async function revoke() {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    setRevoking(true);
    setError(null);
    try {
      await revokeComputer(target.id);
      if (created?.device.id === target.id) setCreated(null);
      setPendingRevoke(null);
      await refresh();
    } catch (err) {
      setPendingRevoke(null);
      setError(userFacingApiError(err, "The computer could not be revoked."));
    } finally {
      setRevoking(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setError("The token could not be copied. Select it and copy it by hand.");
    }
  }


  return (
    <section className="space-y-3">
      <SettingsHeading>Computers</SettingsHeading>
      <SettingsDescription>
        Connect your own Mac so chat can look at its screen and use it on your
        behalf. A small helper app on the Mac connects with a token that only
        you hold.
      </SettingsDescription>

      <SettingsCard>
        {devices === null ? (
          <ComputersSkeleton />
        ) : devices.length === 0 ? (
          <SettingsRow>
            <SettingsDescription>No computers connected yet.</SettingsDescription>
          </SettingsRow>
        ) : (
          devices.map((device) => (
            <SettingsRow key={device.id}>
              <div className="min-w-0 space-y-1">
                <SettingsLabel>
                  <span className="break-words">{device.name}</span>
                </SettingsLabel>
                {platformText(device) && (
                  <SettingsDescription>{platformText(device)}</SettingsDescription>
                )}
                <SettingsDescription>{lastSeenText(device)}</SettingsDescription>
              </div>
              <PillButtonUI
                tone="black"
                size="sm"
                onClick={() => setPendingRevoke(device)}
                aria-label={`Revoke ${device.name}`}
                className="shrink-0"
              >
                Revoke
              </PillButtonUI>
            </SettingsRow>
          ))
        )}

        <SettingsRow layout="stacked">
          <div className="space-y-1">
            <SettingsLabel>Add a computer</SettingsLabel>
            <SettingsDescription>
              Name it so you can tell your computers apart.
            </SettingsDescription>
          </div>
          <form
            className="flex min-w-0 flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <SettingsTextInput
              aria-label="Computer name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              disabled={creating}
              className="min-w-0 sm:flex-1"
            />
            <PillButtonUI
              type="submit"
              tone="blue"
              size="sm"
              disabled={creating || !name.trim()}
              loading={creating}
              className="shrink-0"
            >
              {creating ? "Adding..." : "Add"}
            </PillButtonUI>
          </form>
        </SettingsRow>

        {created && (
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Set up {created.device.name}</SettingsLabel>
              <SettingsDescription>
                This token is shown only once. Copy it now; if you lose it,
                revoke this computer and add it again.
              </SettingsDescription>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <input
                readOnly
                aria-label="Device token"
                value={created.token}
                onFocus={(event) => event.currentTarget.select()}
                className={`h-10 min-w-0 font-mono sm:flex-1 ${SETTINGS_CONTROL_CLASS}`}
              />
              <PillButtonUI
                tone="black"
                size="sm"
                onClick={() => void copyToken()}
                aria-label="Copy token"
                className="shrink-0"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </PillButtonUI>
            </div>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Server address</SettingsLabel>
              <p className="break-all font-mono text-sm text-gray-500">
                {serverAddress}
              </p>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-500">
              <li>
                Build and open the helper from the{" "}
                <code>computer-helper/</code> folder (see its README).
              </li>
              <li>
                Grant Accessibility and Screen Recording when asked, then
                choose Restart in its menu.
              </li>
              <li>
                Paste this token and the server address into its config (choose
                Open config from its menu).
              </li>
              <li>
                In a chat, pick a model that can see images and ask it to use
                your Mac.
              </li>
            </ol>
          </SettingsRow>
        )}

        {error && (
          <p className="px-4 py-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </SettingsCard>

      <ConfirmPopup
        open={pendingRevoke !== null}
        title="Revoke this computer?"
        message={
          pendingRevoke
            ? `${pendingRevoke.name} will stop working with chat until you add it again.`
            : undefined
        }
        confirmLabel="Revoke"
        confirmVariant="danger"
        confirmStatus={revoking ? "loading" : "idle"}
        onConfirm={() => void revoke()}
        onCancel={() => {
          if (!revoking) setPendingRevoke(null);
        }}
      />
    </section>
  );
}
