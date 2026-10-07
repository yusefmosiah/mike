/**
 * Auto Mode guardrail policy: which tool calls may run without a human in the
 * loop, and what "in scope" means for the workspace-scoped ones.
 *
 * Three tiers, fail closed:
 *  - Tier 1: reads and pure computation with no workspace side effects.
 *    Always allowed.
 *  - Tier 2: document writes the caller is already authorized for (the
 *    `allowDocumentMutation` decision upstream). Allowed, but only while the
 *    call stays inside the turn's own container — see `inScopeForContainer`.
 *  - Tier 3: everything else — connector writes, `web_search` and
 *    `fetch_web_page` (a query or URL can carry matter text to an arbitrary
 *    host, so they are never auto-approved), `ask_inputs`, and every tool
 *    name this file has never heard of. CourtListener reads also leave the
 *    network but stay Tier 1 for now: they reach one fixed case-law host.
 *    Tier 3 calls go to the on-route classifier (./classifier.ts). An
 *    unrecognized name is never a reason to assume the call is harmless.
 *
 * The tool names are spelled out here instead of imported from
 * modules/chat/engine/tools/toolSchemas.ts on purpose: src/lib never imports
 * src/modules. The failure mode of drift is one-directional — a tool missing
 * from these sets degrades to Tier 3 (classify or deny), never to a silent
 * allow. Mirrored sources: toolSchemas.ts (TOOLS, TABULAR_TOOLS,
 * WORKFLOW_TOOLS, DOCUMENT_MUTATING_TOOL_NAMES) and
 * courtlistenerTools.ts (COURTLISTENER_TOOL_NAMES).
 */

export type GuardrailTier = 1 | 2 | 3;

/** Reads and pure computation: no workspace side effects, so no judgment. */
export const TIER_1_READ_TOOLS: ReadonlySet<string> = new Set([
  // Document, library, project and tabular reads.
  "read_document",
  "fetch_documents",
  "find_in_document",
  "list_documents",
  "read_table_cells",
  "get_diff",
  // Workflow catalog reads.
  "list_workflows",
  "read_workflow",
  // CourtListener reads.
  "courtlistener_search_case_law",
  "courtlistener_get_cases",
  "courtlistener_find_in_case",
  "courtlistener_read_case",
  "courtlistener_verify_citations",
]);

/**
 * Workspace-scoped writes: they create or rewrite stored documents. Allowed in
 * Auto Mode only when the turn's caller already holds the mutation
 * authorization (`allowDocumentMutation`) and the arguments stay inside the
 * turn's container.
 */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "edit_document",
  "replicate_document",
  "generate_docx",
  "generate_excel",
  "generate_ppt",
]);

/**
 * Tier for a tool name. Unknown, empty and missing names are Tier 3: the
 * classifier judges them or they are denied — never silently allowed.
 */
export function tierForTool(name: string | null | undefined): GuardrailTier {
  if (!name) return 3;
  if (TIER_1_READ_TOOLS.has(name)) return 1;
  if (DOCUMENT_WRITE_TOOLS.has(name)) return 2;
  return 3;
}

/**
 * The deterministic answers Auto Mode gives to model-emitted `ask_inputs`
 * items. In Auto Mode the tool is not advertised, so this only covers calls
 * the model produced anyway. Keys mirror the item `kind`s of the ask_inputs
 * schema (modules/chat/engine/tools/toolSchemas.ts) plus the connector
 * approval flow:
 *  - choice / multi_choice: select the first presented option.
 *  - text: answer with an empty string.
 *  - documents: nothing can be uploaded without a human, so the item is
 *    recorded as skipped.
 *  - approval: deny. Auto Mode never auto-approves a write.
 */
export const AUTO_MODE_SAFE_DEFAULTS = {
  choice: "first_option",
  multi_choice: "first_option",
  text: "",
  documents: "skip",
  approval: "deny",
} as const;

/** Argument keys that explicitly point a call at a container (project/folder). */
const CONTAINER_TARGET_KEYS: ReadonlySet<string> = new Set([
  "project_id",
  "projectId",
  "target_project_id",
  "targetProjectId",
  "library_folder_id",
  "libraryFolderId",
  "target_library_folder_id",
  "targetLibraryFolderId",
]);

/**
 * Argument keys that *look* like they point at a container but are not on the
 * list above (e.g. `target_folder_id`, `drive_folder_id`). They are treated as
 * out of scope: a call naming a container Mike cannot place inside the turn's
 * container has not been proven to stay inside it.
 */
const CONTAINER_LIKE_KEY_PATTERN = /project|library|folder|drive|container/i;

/**
 * Depth past which arguments are no longer inspectable. Nested data is not a
 * reason to trust it: an unscannable payload is out of scope.
 */
const MAX_SCOPE_DEPTH = 6;

/** Stands in for a container target that is present but not a usable id. */
const UNUSABLE_TARGET = "[unusable]";

/**
 * Whether a Tier 2 (or Tier 3) call's arguments stay inside the turn's own
 * container. Conservative by construction:
 *  - an explicit target (project_id, library_folder_id, target_project_id,
 *    camelCase variants, at any nesting level) must equal the container;
 *  - a target named while the turn has no container is out of scope;
 *  - an unrecognized container-ish key is out of scope;
 *  - null/empty/absent targets name no container and are ignored.
 */
export function inScopeForContainer(
  args: Record<string, unknown> | null | undefined,
  containerProjectId?: string | null,
): boolean {
  const id =
    typeof containerProjectId === "string" ? containerProjectId.trim() : "";
  return scanScope(args, id || null, 0);
}

function scanScope(
  value: unknown,
  containerId: string | null,
  depth: number,
): boolean {
  if (depth > MAX_SCOPE_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((entry) => scanScope(entry, containerId, depth + 1));
  }
  if (typeof value !== "object" || value === null) return true;
  for (const [key, entry] of Object.entries(value)) {
    const knownTarget = CONTAINER_TARGET_KEYS.has(key);
    if (knownTarget || CONTAINER_LIKE_KEY_PATTERN.test(key)) {
      // null = names no container; anything else is a container claim.
      let target: string | null = null;
      if (typeof entry === "string") target = entry.trim() || null;
      else if (typeof entry === "number" && Number.isFinite(entry)) {
        target = String(entry);
      } else if (entry !== null && entry !== undefined) {
        target = UNUSABLE_TARGET;
      }
      if (target !== null && (target !== containerId || !knownTarget)) {
        return false;
      }
    }
    if (!scanScope(entry, containerId, depth + 1)) return false;
  }
  return true;
}
