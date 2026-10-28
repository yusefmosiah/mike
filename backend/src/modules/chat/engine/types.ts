export { STANDARD_FONT_DATA_URL } from "../../../lib/pdfText";

// Re-exported so the chat modules that already import it from here keep
// working; the definition lives in lib/log.ts.
export { devLog } from "../../../lib/log";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type DocStore = Map<
  string,
  {
    storage_path: string;
    file_type: string;
    filename: string;
    /** Identifies source material that must be copied before it is edited. */
    source_kind?: "document" | "library_template" | "workflow_asset";
    /**
     * Request-scoped plain text that is already available in memory. Inline
     * documents still flow through read_document so their body only reaches
     * the model when it chooses to read them.
     */
    inline_text?: string;
    /** Relative path under ~/mike when mirrored into the user's workstation. */
    workspace_path?: string;
  }
>;

export type WorkflowStore = Map<
  string,
  {
    title: string;
    skill_md: string;
    listed?: boolean;
    /** The skill's name in the standard's spelling ("contract-review"). */
    name?: string;
    /** Its current text was read (read_workflow) or saved during this turn. */
    read?: boolean;
    description?: string | null;
    /** The skill's other files (scripts/, references/), as one stored zip. */
    files?: { path: string; size: number }[] | null;
    files_path?: string | null;
    assets?: {
      asset_id: string;
      filename: string;
      file_type: string;
      storage_path: string;
    }[];
  }
>;

export type DocIndex = Record<
  string,
  {
    document_id: string;
    filename: string;
    version_id?: string | null;
    version_number?: number | null;
    /** Relative path under ~/mike when mirrored into the user's workstation. */
    workspace_path?: string;
  }
>;

export type TabularCellStore = {
  columns: { index: number; name: string }[];
  documents: { id: string; filename: string }[];
  /** key: `${colIndex}:${docId}` */
  cells: Map<
    string,
    { summary: string; flag?: string; reasoning?: string } | null
  >;
};

export type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: string;
  content: string | null;
  files?: {
    filename: string;
    document_id?: string;
    version_id?: string;
    version_number?: number;
  }[];
  workflow?: { id: string; title: string };
};

/**
 * Per-quote verification result. `start_char`/`end_char` index into the
 * EXTRACTED source text (not the raw file bytes) and are only present for
 * single-segment quotes that matched.
 */
export type { QuoteVerification } from "@mike/contracts";
import type { QuoteVerification } from "@mike/contracts";

// ---------------------------------------------------------------------------
// Doc resolution helpers (used by citations + documentOps)
// ---------------------------------------------------------------------------

export function resolveDoc(rawId: string, docIndex: DocIndex) {
  return docIndex[rawId];
}

/**
 * Resolve whatever identifier the model passed (`doc-N` slug, filename, or
 * document UUID) back to a chat-local doc label.
 */
function normalizeWorkspaceLookupPath(rawId: string): string {
  return rawId
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:~\/mike\/|\/home\/[^/]+\/mike\/|\.?\/?mike\/|\.?\/)+/i, "")
    .replace(/\/+$/, "");
}

export function resolveDocLabel(
  rawId: string,
  docStore: DocStore,
  docIndex?: DocIndex,
): string | null {
  if (docStore.has(rawId)) return rawId;
  const normalizedPath = normalizeWorkspaceLookupPath(rawId);
  for (const [label, info] of docStore.entries()) {
    if (info.filename === rawId) return label;
    if (
      info.workspace_path &&
      (info.workspace_path === normalizedPath ||
        info.workspace_path.toLowerCase() === normalizedPath.toLowerCase())
    ) {
      return label;
    }
  }
  if (docIndex) {
    for (const [label, info] of Object.entries(docIndex)) {
      if (info.document_id === rawId) return label;
      if (
        info.workspace_path &&
        (info.workspace_path === normalizedPath ||
          info.workspace_path.toLowerCase() === normalizedPath.toLowerCase())
      ) {
        return label;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event / annotation types (shared between toolDispatcher and streaming)
// ---------------------------------------------------------------------------

export type { AskInputOption } from "@mike/contracts";
import type { AskInputOption } from "@mike/contracts";

export const MAX_ASK_INPUT_TEXT_LENGTH = 5_000;
/** What the user sees for a failed tool call; the raw error stays server-side. */
export const TOOL_ERROR_MESSAGE = "This tool could not complete its request.";

export type { AskInputItem } from "@mike/contracts";
import type { AskInputItem } from "@mike/contracts";

export type { AskInputsEvent } from "@mike/contracts";
import type { AskInputsEvent } from "@mike/contracts";

export type { AskInputResponseItem } from "@mike/contracts";
import type { AskInputResponseItem } from "@mike/contracts";

export type { AskInputsResponseRequest } from "@mike/contracts";
import type { AskInputsResponseRequest } from "@mike/contracts";

export type { EditAnnotation } from "@mike/contracts";
import type { EditAnnotation } from "@mike/contracts";
