"use client";

import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { MemoryVersionHistory } from "@/app/components/memory/MemoryVersionHistory";
import { Modal } from "@/app/components/modals/Modal";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  getProjectMemory,
  getUserMemory,
  type MemoryCurrent,
  type MemoryFileRef,
} from "@/app/lib/mikeApi";

/**
 * A memory file's version history on its own, for surfaces that have no
 * memory editor of their own (a chat's "Memory updated" row). Restoring is
 * offered; the server refuses it to anyone who may only read the file.
 */
export function MemoryHistoryModal({
  open,
  onClose,
  fileRef,
  initialVersionId,
}: {
  open: boolean;
  onClose: () => void;
  fileRef: MemoryFileRef;
  initialVersionId?: string | null;
}) {
  const [current, setCurrent] = useState<MemoryCurrent | null>(null);
  const [loadError, setLoadError] = useState(false);
  const projectId = fileRef.scope === "project" ? fileRef.projectId : null;

  const fetchCurrent = useCallback(
    (signal?: AbortSignal) =>
      projectId ? getProjectMemory(projectId, signal) : getUserMemory(signal),
    [projectId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchCurrent(controller.signal).then(setCurrent, () => {
      if (!controller.signal.aborted) setLoadError(true);
    });
    return () => controller.abort();
  }, [open, fetchCurrent]);

  function retry() {
    setLoadError(false);
    fetchCurrent().then(setCurrent, () => setLoadError(true));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      breadcrumbs={[projectId ? "Project Memory" : "Memory", "Version history"]}
      primaryAction={{ label: "Done", type: "button", onClick: onClose }}
    >
      <div className="flex min-h-0 flex-1 flex-col pb-3 pt-1">
        {loadError ? (
          <EmptyState
            icon={<History />}
            title="Memory could not be loaded"
            description="Try again to see its version history."
            tone="error"
            className="px-5 py-8"
            action={
              <PillButtonUI tone="black" size="sm" onClick={retry}>
                Retry
              </PillButtonUI>
            }
          />
        ) : current ? (
          <MemoryVersionHistory
            fileRef={fileRef}
            current={current}
            canRestore={current.enabled}
            initialVersionId={initialVersionId}
            onRestored={setCurrent}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row" aria-label="Loading version history">
            <div className="h-40 animate-pulse rounded-xl bg-gray-100 sm:w-56" />
            <div className="min-h-48 flex-1 animate-pulse rounded-xl bg-gray-100" />
          </div>
        )}
      </div>
    </Modal>
  );
}
