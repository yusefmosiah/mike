/**
 * Step sources: what each tool call touched, named by the call that touched
 * it. The timeline shows a step's sources under the step, and the summaries
 * and the activity log build on the same record
 * (docs/reports/step-summaries-2026-10-24.md).
 *
 * The dispatcher runs one call at a time, so every SSE frame and every event
 * it produces while a call runs belongs to that call. `withCallId` stamps the
 * frames and `stampCallIds` the events, in one place rather than at each of
 * the dispatcher's push sites.
 */

const DATA_PREFIX = "data: ";

/** The frame, with `call_id` added to its JSON event when it has none. */
export function withCallId(chunk: string, callId: string): string {
  if (!chunk.startsWith(DATA_PREFIX) || !chunk.endsWith("\n\n")) return chunk;
  const body = chunk.slice(DATA_PREFIX.length, -2);
  if (!body.startsWith("{")) return chunk;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return chunk;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return chunk;
  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== "string" || event.call_id !== undefined) return chunk;
  return `${DATA_PREFIX}${JSON.stringify({ ...event, call_id: callId })}\n\n`;
}

/** Each list's length before a call, so the entries it adds can be found. */
export function sourceMarks(lists: readonly unknown[][]): number[] {
  return lists.map((list) => list.length);
}

/** Names `callId` on every object a call added to the lists since `marks`. */
export function stampCallIds(lists: readonly unknown[][], marks: readonly number[], callId: string): void {
  lists.forEach((list, index) => {
    for (let i = marks[index] ?? 0; i < list.length; i++) {
      const entry = list[i];
      if (entry && typeof entry === "object" && !("call_id" in entry && (entry as { call_id?: unknown }).call_id)) {
        (entry as { call_id?: string }).call_id = callId;
      }
    }
  });
}

/**
 * Every tool says what it touches. `sources`: its events name documents,
 * pages, cases or connector calls. `none`: it reads and writes nothing a
 * reader would count as a source (a question to the user, a list of names).
 * `pending`: it touches sources that are not recorded yet; the comment says
 * what is missing. stepSources.test.ts fails for a tool missing here, so a
 * new tool cannot ship without saying what it touches.
 */
export const TOOL_SOURCES: Record<string, "sources" | "none" | "pending"> = {
  // Documents
  read_document: "sources",
  fetch_documents: "sources",
  find_in_document: "sources",
  find_in_documents: "sources",
  list_documents: "none",
  get_diff: "pending", // compares two versions; records neither
  edit_document: "sources",
  replicate_document: "sources",
  generate_docx: "sources",
  generate_excel: "sources",
  generate_ppt: "sources",
  generate_html: "sources",
  save_to_mike: "sources",
  show_media: "sources",
  read_table_cells: "pending", // tabular review cells; no event yet
  check_citations: "pending", // checks a document's citations; no event yet
  // The web
  web_search: "sources",
  fetch_web_page: "sources",
  // Case law
  courtlistener_get_cases: "sources",
  courtlistener_find_in_case: "sources",
  courtlistener_read_case: "sources",
  courtlistener_verify_citations: "sources",
  // Workflows and skills
  list_workflows: "none",
  read_workflow: "sources",
  save_skill: "sources",
  install_skill: "sources",
  // Memory and history
  read_memory: "pending", // answered in the kernel host; no event yet
  edit_memory: "sources",
  history_search: "pending", // answered in the kernel host; no event yet
  history_read: "pending",
  // The user
  ask_inputs: "none",
  // Subagents (their own steps roll up through the subagent event)
  delegate: "sources",
  list_agents: "none",
  message_agent: "none",
  agent_inbox: "none",
  stop_agent: "none",
  // Code: a cell's sources are the calls it makes (`<cell call_id>.<n>`)
  run_python: "sources",
  // Vault: credential leases, audited by the vault itself, not sources
  vault_secrets: "none",
  vault_request_secret: "none",
  publish_document: "none",
  vault_lease: "none",
  // The person's computer: what is on their screen is not a source
  computer_observe: "none",
  computer_act: "none",
  // Word add-in (client tools)
  read_active_document: "pending", // the open Word document; no event yet
  apply_word_edits: "sources",
};

/**
 * Tools whose names are built per user (MCP servers, Google Drive and
 * Workspace): each call is recorded as an `mcp_tool_call` naming the
 * connector and tool. The resource inside it (which file, which thread) is
 * not recorded yet.
 */
export const TOOL_SOURCE_PREFIXES: readonly string[] = ["mcp_", "google_drive_", "gmail_", "google_calendar_"];

/** What a tool records about its sources, or null for a tool nobody accounted for. */
export function toolSourceAccounting(name: string): "sources" | "none" | "pending" | null {
  if (Object.hasOwn(TOOL_SOURCES, name)) return TOOL_SOURCES[name]!;
  return TOOL_SOURCE_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "sources" : null;
}
