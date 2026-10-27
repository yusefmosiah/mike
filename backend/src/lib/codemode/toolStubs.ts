/**
 * One line for each built-in function the model can call from Python: what it
 * is for, when to reach for it and, where two are easily confused, what it is
 * not for. The tool index (python.ts, pythonToolIndex) shows these instead of
 * each function's full documentation, which `help(tools.<name>)` prints on
 * demand; a function's full schema stays the source of truth for its
 * parameters.
 *
 * A line is worth its tokens only if it tells the model something the name
 * does not: the moment to use the function. Keep each under about 200
 * characters, and keep them fixed: the index is cached as long as its text is.
 */

/** The index's groups, in the order it lists them. */
export const TOOL_GROUPS = [
  "Documents",
  "Drafting and editing",
  "Research",
  "This conversation and memory",
  "Asking the person",
  "Skills",
  "Credentials",
  "Subagents",
  "The person's computer",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export type ToolStub = { group: ToolGroup; text: string };

export const TOOL_STUBS: Readonly<Record<string, ToolStub>> = {
  // Documents
  read_document: {
    group: "Documents",
    text: "a document's text in windows, or one section by clause number. Use before answering about, quoting from or editing a document. Prefer `docs` for structure and grep.",
  },
  find_in_document: {
    group: "Documents",
    text: "Ctrl+F inside one document: each match with its block id and context. Use to locate exact wording before quoting or editing.",
  },
  find_in_documents: {
    group: "Documents",
    text: "the same search across several documents at once. Use to learn which documents mention a party, term or figure before reading any.",
  },
  list_documents: {
    group: "Documents",
    text: "every document in the project, with ids and file types. Use when `docs` may not hold all of the project's documents.",
  },
  show_media: {
    group: "Documents",
    text: "show an image, audio or video document inline in the reply, at this point. Use for media the person should see; save a workstation file first.",
  },
  fetch_documents: {
    group: "Documents",
    text: "several documents' text in one call, each as an opening window. Prefer `docs` for reading.",
  },
  read_table_cells: {
    group: "Documents",
    text: "the values a tabular review extracted, by column and row. Use to answer about the review's results.",
  },
  read_active_document: {
    group: "Documents",
    text: "the document open in Word, read live, including edits made this turn. Use after apply_word_edits to check them.",
  },

  // Drafting and editing
  edit_document: {
    group: "Drafting and editing",
    text: "propose tracked changes to a .docx by block id. Use for any change to an existing document. Not for new documents (generate_docx).",
  },
  get_diff: {
    group: "Drafting and editing",
    text: "the pending changes of an edited document, with integrity checks. Use after edit_document, before saying the edit is done.",
  },
  apply_word_edits: {
    group: "Drafting and editing",
    text: "propose tracked changes to the document open in Word, by exact passage. Not for documents in the app (edit_document).",
  },
  replicate_document: {
    group: "Drafting and editing",
    text: "copy a document, template or skill file without changing it. Use before editing a template, or when asked for a copy.",
  },
  generate_docx: {
    group: "Drafting and editing",
    text: "create a new Word document from sections. Use when asked to draft a new document. Not for changing one (edit_document).",
  },
  generate_excel: {
    group: "Drafting and editing",
    text: "create an Excel workbook from sheets of rows. Use for a tracker, schedule, matrix or other spreadsheet.",
  },
  generate_ppt: {
    group: "Drafting and editing",
    text: "create a PowerPoint deck from slides. Use when asked for slides or a presentation.",
  },
  generate_html: {
    group: "Drafting and editing",
    text: "create an HTML page (article, report, briefing) with tables, images, embedded video and audio, and links. Use for something to read in a browser or publish as a link.",
  },
  save_to_mike: {
    group: "Drafting and editing",
    text: "save a file from the workstation into the person's documents, new or as a new version. The only way a workstation file reaches them.",
  },

  // Research
  web_search: {
    group: "Research",
    text: "ranked web results for current or outside information: law, news, filings, prices. Use for anything the documents do not hold.",
  },
  fetch_web_page: {
    group: "Research",
    text: "a web page as clean text, in windows, stored for citation. Use to read a result before citing it.",
  },
  check_citations: {
    group: "Research",
    text: "check every citation in a document against its source. Slow and costly per citation; use when the person asks or before a draft goes out.",
  },
  courtlistener_verify_citations: {
    group: "Research",
    text: "look up case citations such as \"467 U.S. 837\" in CourtListener. Use to confirm a case exists before relying on it.",
  },
  courtlistener_get_cases: {
    group: "Research",
    text: "fetch CourtListener cases by cluster id (metadata only). Call before courtlistener_find_in_case or courtlistener_read_case.",
  },
  courtlistener_find_in_case: {
    group: "Research",
    text: "find passages in a fetched case's opinions.",
  },
  courtlistener_read_case: {
    group: "Research",
    text: "read a fetched case's opinion text, when passages are not enough.",
  },

  // This conversation and memory
  history_search: {
    group: "This conversation and memory",
    text: "find messages and tool results anywhere in this chat, including what a compaction summary left out. Use when the person refers back to something ('earlier', 'as I said'), before quoting exact wording, a number, date or source from earlier, and before saying something was not discussed. Not for documents (find_in_document).",
  },
  history_read: {
    group: "This conversation and memory",
    text: "read one message of this chat in full by its id (m41), or a run of them. Use after history_search, or for an id a summary names.",
  },
  read_memory: {
    group: "This conversation and memory",
    text: "the persisted memory as it is now. Use only when it may have changed since this chat began.",
  },
  edit_memory: {
    group: "This conversation and memory",
    text: "change persisted memory. Use when the person asks you to remember, correct or forget something, or states a lasting preference. Not for details of this task.",
  },

  // Asking the person
  ask_inputs: {
    group: "Asking the person",
    text: "ask the person for decisions, answers or documents, all in one call; the turn ends there. Use when a guess would change the answer.",
  },

  // Skills
  list_workflows: {
    group: "Skills",
    text: "the person's skills, with ids. Use when the skills list in this context was shortened.",
  },
  read_workflow: {
    group: "Skills",
    text: "a skill's instructions, then follow them. Use when a skill fits the request.",
  },
  save_skill: {
    group: "Skills",
    text: "save or change a skill. Use when asked to turn a way of working, or a prompt, into a skill.",
  },
  install_skill: {
    group: "Skills",
    text: "install a published skill from a GitHub link. Use when the person gives one.",
  },

  // Publishing
  publish_document: {
    group: "Drafting and editing",
    text: "ask the person to publish a document as a link (they choose who can open it and set any password); the turn pauses until they do.",
  },

  // Credentials
  vault_secrets: {
    group: "Credentials",
    text: "the credentials the person has stored, never their values. Check here before asking for one.",
  },
  vault_request_secret: {
    group: "Credentials",
    text: "ask the person to store a credential; the turn pauses until they do. Use when a task needs one they have not stored.",
  },
  vault_lease: {
    group: "Credentials",
    text: "a short-lived lease to use a stored credential from the workstation, for this turn only.",
  },

  // Subagents
  delegate: {
    group: "Subagents",
    text: "hand a self-contained task to a subagent and get its report. Use for independent pieces of work; gather several to run them at once.",
  },
  list_agents: {
    group: "Subagents",
    text: "this chat's background subagents: names, status, last reports. Use before messaging one, or to see what is still working.",
  },
  message_agent: {
    group: "Subagents",
    text: "message a background subagent by name (or the chat, from a subagent): redirect its work, or give it more after it finished.",
  },
  agent_inbox: {
    group: "Subagents",
    text: "collect background subagents' reports, waiting up to wait_seconds. Use when your answer needs them; uncollected reports arrive in the chat later.",
  },
  stop_agent: {
    group: "Subagents",
    text: "stop a background subagent's current work when it is no longer needed or has gone wrong.",
  },

  // The person's computer
  computer_observe: {
    group: "The person's computer",
    text: "see the person's own computer: the front app's controls with refs, and a screenshot attached to this cell's result.",
  },
  computer_act: {
    group: "The person's computer",
    text: "click, type, press keys, scroll and open apps on the person's computer, by ref from the latest observe.",
  },
};

/**
 * Functions whose full documentation the index carries too, when they are
 * offered: their arguments are nested enough that a call written from the
 * one line alone usually fails.
 */
export const FULL_DOC_TOOLS: readonly string[] = [
  "edit_document",
  "apply_word_edits",
  "generate_docx",
  "ask_inputs",
  "computer_observe",
  "computer_act",
];

/** Connectors whose functions share a name prefix, collapsed to one line each. */
export const CONNECTOR_PREFIXES: readonly { prefix: string; name: string }[] = [
  { prefix: "gmail_", name: "Gmail" },
  { prefix: "google_calendar_", name: "Google Calendar" },
  { prefix: "google_drive_", name: "Google Drive" },
];
