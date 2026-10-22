"use client";

import { useMemo, useState } from "react";
import { Brain } from "lucide-react";
import { EventBlock } from "@/app/components/assistant/message/EventBlocks";
import { MemoryHistoryModal } from "@/app/components/memory/MemoryHistoryModal";
import type { MemoryFileRef } from "@/app/lib/mikeApi";
import type { AssistantEvent } from "../../shared/types";

type MemoryUpdatedEvent = Extract<AssistantEvent, { type: "memory_updated" }>;

/**
 * The assistant changed a memory file. Shown plainly, in blue, so the person
 * notices; it opens that file's history at the version the change made,
 * where they can compare it and restore an earlier one.
 */
export function MemoryUpdatedBlock({
  event,
  showConnector,
}: {
  event: MemoryUpdatedEvent;
  showConnector?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const projectId = event.scope === "project" ? event.project_id : null;
  const fileRef = useMemo<MemoryFileRef>(
    () => (projectId ? { scope: "project", projectId } : { scope: "user" }),
    [projectId],
  );
  const label = projectId ? "Project memory updated" : "Memory updated";
  return (
    <EventBlock showConnector={showConnector} dotColor="blue">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-0.5 font-sans text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {label}
        {event.version_number ? (
          <span className="font-normal text-blue-600">
            · version {event.version_number}
          </span>
        ) : null}
      </button>
      {event.summary ? (
        <p className="mt-1 break-words text-gray-600">{event.summary}</p>
      ) : null}
      <MemoryHistoryModal
        open={open}
        onClose={() => setOpen(false)}
        fileRef={fileRef}
        initialVersionId={event.version_id}
      />
    </EventBlock>
  );
}
