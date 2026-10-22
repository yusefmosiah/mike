"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import {
  getMemoryVersion,
  listMemoryVersions,
  MikeApiError,
  restoreMemoryVersion,
  type MemoryCurrent,
  type MemoryFileRef,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { lineDiff } from "@/app/lib/lineDiff";
import { cn } from "@/app/lib/utils";
import { userFacingApiError } from "@/app/lib/userFacingError";

type View = "changes" | "text";

const VIEW_OPTIONS = [
  { value: "changes" as const, label: "Changes" },
  { value: "text" as const, label: "Full text" },
];

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Who or what made a version, in a few words. */
export function memoryVersionLabel(
  version: MemoryVersion,
  currentUserId: string | null,
): string {
  switch (version.source) {
    case "manual":
      if (version.updated_by && version.updated_by === currentUserId)
        return "Edited by you";
      return version.updated_by_name
        ? `Edited by ${version.updated_by_name}`
        : "Edited";
    case "curator":
      return "Updated from a chat";
    case "assistant":
      return "Changed by the assistant in a chat";
    case "restore":
      return version.change_summary ?? "Restored an earlier version";
    case "settings":
      return "Memory turned off";
    case "wipe":
      return "Memory cleared";
  }
}

/**
 * The saved versions of one memory file: a list, the selected version as a
 * diff against the one before it or as full text, and restoring it as the
 * newest version. Restoring writes against `current.revision`, so an edit
 * made meanwhile is refused rather than overwritten.
 */
export function MemoryVersionHistory({
  fileRef,
  current,
  canRestore,
  restoreBlockedReason,
  initialVersionId,
  onRestored,
}: {
  fileRef: MemoryFileRef;
  current: MemoryCurrent;
  canRestore: boolean;
  /** Set while the editor holds unsaved text; restoring would discard it. */
  restoreBlockedReason?: string | null;
  initialVersionId?: string | null;
  onRestored: (current: MemoryCurrent) => void;
}) {
  const { user } = useAuth();
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [listError, setListError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialVersionId ?? null,
  );
  const [contents, setContents] = useState<Record<string, string>>({});
  const [contentError, setContentError] = useState(false);
  const [view, setView] = useState<View>("changes");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const scopeKey =
    fileRef.scope === "user" ? "user" : `project:${fileRef.projectId}`;

  const loadVersions = useCallback(
    async (signal?: AbortSignal) => {
      setListError(false);
      try {
        const listed = await listMemoryVersions(fileRef, signal);
        setVersions(listed);
        setSelectedId((selected) =>
          selected && listed.some((version) => version.id === selected)
            ? selected
            : (listed[0]?.id ?? null),
        );
      } catch {
        if (!signal?.aborted) setListError(true);
      }
    },
    // The ref is rebuilt by each render of the host; its scope key is what
    // identifies the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadVersions(controller.signal);
    return () => controller.abort();
  }, [loadVersions, current.revision]);

  const selectedIndex = versions?.findIndex((v) => v.id === selectedId) ?? -1;
  const selected = selectedIndex >= 0 ? versions![selectedIndex]! : null;
  const previous =
    selectedIndex >= 0 ? (versions![selectedIndex + 1] ?? null) : null;

  useEffect(() => {
    if (!selected) return;
    const needed = [selected, previous].filter(
      (version): version is MemoryVersion =>
        !!version && contents[version.id] === undefined,
    );
    if (needed.length === 0) return;
    const controller = new AbortController();
    setContentError(false);
    Promise.all(
      needed.map((version) =>
        getMemoryVersion(fileRef, version.id, controller.signal),
      ),
    )
      .then((loaded) =>
        setContents((known) => {
          const next = { ...known };
          for (const version of loaded) next[version.id] = version.content;
          return next;
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setContentError(true);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, previous?.id, scopeKey]);

  const selectedText = selected ? contents[selected.id] : undefined;
  const previousText = previous ? contents[previous.id] : "";
  const diff = useMemo(
    () =>
      selectedText !== undefined && previousText !== undefined
        ? lineDiff(previousText, selectedText)
        : null,
    [previousText, selectedText],
  );
  const isNewest = selectedIndex === 0;

  async function restore() {
    if (!selected || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const restored = await restoreMemoryVersion(
        fileRef,
        selected.id,
        current.revision,
      );
      setConfirmOpen(false);
      setSelectedId(null);
      onRestored(restored);
    } catch (cause) {
      setConfirmOpen(false);
      setRestoreError(
        cause instanceof MikeApiError && cause.status === 409
          ? "Memory changed while you were looking. Check the newest version, then try again."
          : cause instanceof MikeApiError && cause.status === 403
            ? "You can view this memory but not restore it."
            : userFacingApiError(
              cause,
              "That version could not be restored. Please try again.",
            ),
      );
    } finally {
      setRestoring(false);
    }
  }

  if (listError) {
    return (
      <EmptyState
        icon={<History />}
        title="Version history could not be loaded"
        description="Try again to see earlier versions of this memory."
        tone="error"
        className="px-5 py-8"
        action={
          <PillButtonUI
            tone="black"
            size="sm"
            onClick={() => void loadVersions()}
          >
            Retry
          </PillButtonUI>
        }
      />
    );
  }

  if (!versions) return <MemoryVersionHistorySkeleton />;

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="No versions yet"
        description="Each change to this memory is kept here once it is saved."
        className="px-5 py-8"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
      <ol
        aria-label="Versions"
        className="max-h-48 shrink-0 space-y-1 overflow-y-auto sm:max-h-none sm:w-56"
      >
        {versions.map((version) => {
          const active = version.id === selectedId;
          return (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(version.id);
                  setRestoreError(null);
                }}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "w-full rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300",
                  active ? "bg-gray-100" : "hover:bg-gray-50",
                )}
              >
                <span className="block text-sm text-gray-900">
                  Version {version.version_number}
                  {version === versions[0] ? " (current)" : ""}
                </span>
                <span className="block break-words text-xs text-gray-500">
                  {memoryVersionLabel(version, user?.id ?? null)}
                </span>
                <span className="block text-xs text-gray-400">
                  {formatDate(version.updated_at)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {selected ? (
        <section
          aria-label={`Version ${selected.version_number}`}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ModalSegmentedToggle
              value={view}
              onChange={setView}
              options={VIEW_OPTIONS}
              size="sm"
            />
            {canRestore && !isNewest ? (
              <PillButtonUI
                tone="white"
                size="sm"
                disabled={!!restoreBlockedReason || restoring}
                onClick={() => setConfirmOpen(true)}
              >
                Restore this version
              </PillButtonUI>
            ) : null}
          </div>
          {(selected.source === "curator" || selected.source === "assistant") &&
          selected.change_summary ? (
            <p className="break-words text-sm text-gray-600">
              {selected.change_summary}
            </p>
          ) : null}
          {canRestore && !isNewest && restoreBlockedReason ? (
            <p className="text-xs text-gray-500" role="status">
              {restoreBlockedReason}
            </p>
          ) : null}
          {restoreError ? (
            <p className="text-sm text-red-600" role="alert">
              {restoreError}
            </p>
          ) : null}

          <TextSlabUI className="min-h-0 flex-1 overflow-y-auto">
            {contentError ? (
              <p className="text-sm text-red-600" role="alert">
                This version could not be loaded. Please try again.
              </p>
            ) : selectedText === undefined || diff === null ? (
              <div className="space-y-2" aria-label="Loading version">
                <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-gray-200" />
              </div>
            ) : view === "text" ? (
              selectedText ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800">
                  {selectedText}
                </pre>
              ) : (
                <p className="text-sm text-gray-500">This version is empty.</p>
              )
            ) : (
              <MemoryDiff lines={diff} />
            )}
          </TextSlabUI>
        </section>
      ) : null}

      <ConfirmPopup
        open={confirmOpen}
        title={
          selected ? `Restore version ${selected.version_number}?` : undefined
        }
        message="The memory file will go back to this version. The text it has now stays in the history, so you can return to it."
        confirmLabel="Restore"
        confirmStatus={restoring ? "loading" : "idle"}
        onConfirm={() => void restore()}
        onCancel={() => {
          if (!restoring) setConfirmOpen(false);
        }}
      />
    </div>
  );
}

/** Lines added and removed, each marked with + or − as well as colour. */
function MemoryDiff({ lines }: { lines: ReturnType<typeof lineDiff> }) {
  const changed = lines.some((line) => line.kind !== "same");
  if (!changed)
    return (
      <p className="text-sm text-gray-500">
        No change from the version before.
      </p>
    );
  return (
    <ol aria-label="Changes from the version before" className="text-sm">
      {lines.map((line, index) => (
        <li
          key={index}
          className={cn(
            "flex gap-2 whitespace-pre-wrap break-words",
            line.kind === "added" && "text-green-700",
            line.kind === "removed" && "text-red-600",
            line.kind === "same" && "text-gray-500",
          )}
        >
          <span aria-hidden="true" className="w-3 shrink-0 select-none">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </span>
          <span className="sr-only">
            {line.kind === "added"
              ? "Added: "
              : line.kind === "removed"
                ? "Removed: "
                : ""}
          </span>
          <span
            className={cn("min-w-0", line.kind === "removed" && "line-through")}
          >
            {line.text || " "}
          </span>
        </li>
      ))}
    </ol>
  );
}

function MemoryVersionHistorySkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row"
      aria-label="Loading version history"
    >
      <div className="space-y-2 sm:w-56">
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-1.5 px-3 py-2">
            <div className="h-3.5 w-24 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-36 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-28 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
      <div className="min-h-48 flex-1 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
