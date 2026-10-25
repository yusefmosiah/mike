import { EDIT_MEMORY_TOOL } from "../../../../lib/memory/editTool";
/**
 * The tools that WRITE to stored content rather than read it: they create
 * `documents` rows (and, in a project chat, attach them to the project) or
 * they rewrite an existing document's bytes and versions.
 *
 * Naming them is what lets a surface hand the model a read-only tool set. A
 * chat and the documents it can reach are two different resources with two
 * different owners: standing on the thread (holding a direct grant) says
 * nothing about standing in the project whose documents these tools would
 * rewrite. See `allowDocumentMutation` in ../streaming.ts.
 *
 * save_skill and install_skill write the caller's own skills rather than a
 * document, but they are here too: a read-only seat in someone else's thread
 * should not let that thread's content install instructions for the caller.
 *
 * Everything else in the base set — read_document, find_in_document,
 * list_documents, fetch_documents, ask_inputs, list_workflows, read_workflow
 * and the research tools — only reads, so a collaborator who may talk in the
 * thread keeps the whole conversational surface.
 */
export const DOCUMENT_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit_document",
  "replicate_document",
  "generate_docx",
  "generate_excel",
  "generate_ppt",
  "generate_html",
  "save_to_mike",
  "save_skill",
  "install_skill",
]);

/** Read a tool schema's function name, whatever shape the entry arrived in. */
export function toolName(tool: unknown): string | null {
  const fn = (tool as { function?: { name?: unknown } } | null)?.function;
  return typeof fn?.name === "string" ? fn.name : null;
}

export function isDocumentMutatingTool(name: string | null | undefined): boolean {
  return !!name && DOCUMENT_MUTATING_TOOL_NAMES.has(name);
}

/**
 * Drop every content-writing tool from a tool list. Applied to the whole
 * advertised set (base, project extras, MCP and client tools alike) so a
 * read-only caller cannot be handed a writer through some other list.
 */
export function withoutDocumentMutatingTools<T>(tools: T[]): T[] {
  return tools.filter((tool) => !isDocumentMutatingTool(toolName(tool)));
}

export const PROJECT_EXTRA_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. One call returns about 60,000 characters in all, shared between the documents, so each long document comes back as an opening window; when a document's text ends with a continuation notice, call read_document with that doc_id and the position it names to read further. To find where documents discuss something without reading them, use find_in_documents first. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
          },
        },
        required: ["doc_ids"],
      },
    },
  },
];

export const TABULAR_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_table_cells",
      description:
        "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
      parameters: {
        type: "object",
        properties: {
          col_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
          },
          row_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
          },
        },
      },
    },
  },
];

/**
 * Edits to the persisted memory.md, offered when this conversation may change
 * app or project memory (modules/memory/memory.assistant.ts decides which).
 */
export const MEMORY_TOOLS = [EDIT_MEMORY_TOOL];

/**
 * The conversation's own history, compacted messages included
 * (lib/llm/pi/history.mts), offered in every saved conversation. The turn
 * answers them itself from its Pi transcript.
 */
export const HISTORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "history_search",
      description:
        "Search this conversation's whole history, including what a compaction summary left out: the person's messages, your answers and tool results. Returns matches newest first, each with its id (like m41), role, date, whether it was compacted, and a snippet around the first hit.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to find (case-insensitive), or a regular expression with regex=true." },
          regex: { type: "boolean", description: "Treat query as a regular expression." },
          roles: {
            type: "array",
            items: { type: "string", enum: ["user", "assistant", "tool"] },
            description: "Only these speakers: user (the person), assistant (you), tool (tool results).",
          },
          compacted_only: { type: "boolean", description: "Only messages the current context holds as a summary." },
          limit: { type: "integer", description: "Matches to return (default 20, at most 100)." },
          before: { type: "string", description: "Only matches older than this id: the next page of a search." },
          context_chars: { type: "integer", description: "Characters of snippet on each side of the hit (default 200)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "history_read",
      description:
        "Read one message of this conversation's history in full by its id (from history_search, or a summary's record), from an offset; or the messages from id through another id, in order.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The message's id, like m41." },
          offset: { type: "integer", description: "Character to start at (default 0)." },
          limit_chars: { type: "integer", description: "Characters to return (default 8000, at most 40000)." },
          through: { type: "string", description: "Read every message from id through this id." },
        },
        required: ["id"],
      },
    },
  },
];

const LIST_AGENTS_TOOL = {
  type: "function",
  function: {
    name: "list_agents",
    description:
      "List this chat's background subagents: each one's name, type, model, status (working, done, failed, stopped, timed_out, or ended when it can no longer take messages), its task, its last report, and how many of its messages the chat has not read.",
    parameters: { type: "object", properties: {} },
  },
};

const MESSAGE_AGENT_TOOL = {
  type: "function",
  function: {
    name: "message_agent",
    description:
      'Send a message to a background subagent by its name, or to "parent" (the chat) from a subagent. A subagent that is working reads it before its next step (or, with interrupt=false, once its current work is done); one that has finished takes it as new work. Either way it reports again when done.',
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: 'The subagent\'s name from list_agents, such as research-1, or "parent".' },
        message: { type: "string", description: "The message, self-contained: the subagent sees nothing else of this conversation." },
        interrupt: {
          type: "boolean",
          description: "Read before the subagent's next step (the default), or false to wait until its current work is done.",
        },
      },
      required: ["to", "message"],
    },
  },
};

/**
 * The chat's background subagents (lib/llm/pi/runtime.mts), offered when
 * the person has turned them on: a parent turn's functions. The runtime
 * answers them itself.
 */
export const AGENT_TOOLS = [
  LIST_AGENTS_TOOL,
  MESSAGE_AGENT_TOOL,
  {
    type: "function",
    function: {
      name: "agent_inbox",
      description:
        "Collect the reports and messages this chat's background subagents have sent and you have not read, oldest first, and which are still working. With wait_seconds, wait up to that long for something to arrive when nothing has yet. What you do not collect arrives in the chat after your answer.",
      parameters: {
        type: "object",
        properties: {
          wait_seconds: { type: "integer", description: "Seconds to wait for a report when none is waiting (default 0, at most 600)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_agent",
      description:
        "Stop a background subagent's current work. It keeps what it has done, sends no report for the stopped work, and can be given more with message_agent.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The subagent's name from list_agents." } },
        required: ["name"],
      },
    },
  },
];

/** What a background subagent itself may do with its chat: see the others, and message them or the chat. */
export const CHILD_AGENT_TOOLS = [LIST_AGENTS_TOOL, MESSAGE_AGENT_TOOL];

/** The functions the runtime answers for a chat's background subagents. */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOLS.map((tool) => tool.function.name));

export const WORKFLOW_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_workflows",
      description:
        "List the user's skills (also called workflows), with each one's ID, name and description. The system prompt already lists them when there are not too many; call this when it says the list was shortened, or to check what exists.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read a skill's instructions (its SKILL.md) by ID, then follow them. Pass file to read one of the skill's other files instead, such as a reference it points to.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The skill's ID",
          },
          file: {
            type: "string",
            description: "Optional: a file inside the skill, such as 'references/checklist.md'.",
          },
        },
        required: ["workflow_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_skill",
      description:
        "Save a skill: instructions that any of the user's chats can find and follow, in the standard SKILL.md format. Use it when the user asks to turn what you just did into a skill, to remember a way of working, to save a prompt for reuse, or to change one of their skills. Write for a reader who has none of this conversation: when to use the skill, what to ask for or check first, the steps (naming the tools or commands that worked), what the result should look like, and how to check it. Keep what generalizes and leave out this chat's particular documents and names unless the user wants them. Saving a name the user already has makes a new version of it; to change a skill by ID pass skill_id, and a skill the user cannot edit is saved as their own copy. To change an existing skill, read it with read_workflow first and send its whole text with only the requested changes: the save replaces the previous version. In the workstation you can instead write a folder (SKILL.md plus scripts/, references/, assets/) and pass its path.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short lowercase name with hyphens, such as 'nda-first-pass'.",
          },
          description: {
            type: "string",
            description:
              "One or two sentences: what the skill does and when to use it. Later chats decide whether to use the skill from this alone.",
          },
          instructions: {
            type: "string",
            description: "The SKILL.md body, in Markdown. Frontmatter is optional.",
          },
          files: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional small text files to include, by path, such as {\"scripts/extract.py\": \"...\", \"references/checklist.md\": \"...\"}.",
          },
          path: {
            type: "string",
            description: "Instead of instructions: a skill folder in the workstation that holds a SKILL.md.",
          },
          skill_id: {
            type: "string",
            description: "Optional: the ID of the skill to change.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_skill",
      description:
        "Install a published skill from GitHub as the user's own: a folder that holds a SKILL.md, such as https://github.com/owner/repo/tree/main/skills/name. Use it when the user asks to install or add a skill from a link. Installing copies files and runs nothing; installing the same skill again saves a new version.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The GitHub link to the skill's folder or its SKILL.md." },
        },
        required: ["url"],
      },
    },
  },
];

/**
 * Offered only to users with a workstation VM (lib/workstation, Mission 13):
 * a full Linux userland where code runs as an unprivileged account that
 * holds no secrets. Shell commands run from Python, through subprocess.
 */
export const WORKSTATION_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_to_mike",
      description:
        "Save a file from the workstation into the user's documents: as a new document in this chat's project (or the library), or, with replace, as a new version of a document under ~/mike. This is the only way a workstation file reaches the user's documents. Documents can be PDF, Word, Excel, PowerPoint, images (PNG, JPEG, WebP, GIF) and plain text (.txt, .md, .csv).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file in the workstation, e.g. ~/mike/out/summary.md (absolute or relative to /home/agent).",
          },
          filename: {
            type: "string",
            description: "The document's name, with its extension. Default: the file's own name.",
          },
          replace: {
            type: "string",
            description: "A file under ~/mike (e.g. ~/mike/projects/Acme/Contract.docx) whose document should get this file as its new version, instead of creating a document.",
          },
          to_library: {
            type: "boolean",
            description: "Create the document in the user's library rather than this chat's project.",
          },
        },
        required: ["path"],
      },
    },
  },
];

/**
 * Offered with the workstation when the host runs the secrets vault
 * (infra/vault): the agent uses a stored credential through the vault,
 * which attaches it on the host, so neither the model nor the VM sees it.
 */
export const VAULT_TOOLS = [
  {
    type: "function",
    function: {
      name: "vault_secrets",
      description:
        "List the credentials (API keys, tokens, passwords) the user has stored in their vault: each one's name, the hosts it may be sent to, how it is attached and whether changes need the user's approval. Never the values. Check here before asking the user for a credential.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_request_secret",
      description:
        "Ask the user to store a credential in their vault, when a task needs one they have not stored, or to replace one that does not work (same name: they enter a new value). The user only pastes the value into a secure field in the chat; you choose everything else here, so choose well. It goes straight to the vault; it never appears in the chat, and you never see it. The turn pauses until they save it or decline. Never ask for a credential in the conversation itself, and tell the user not to paste one there.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short name to store it under: lowercase letters, digits, '.', '_' or '-' (e.g. \"github-deploy\").",
          },
          purpose: {
            type: "string",
            description: "One sentence: what you will use it for.",
          },
          hosts: {
            type: "array",
            items: { type: "string" },
            description: "Exact host names it will be sent to, e.g. [\"api.example.com\"]; no wildcards. HTTPS only. The user confirms these, and the secret can never go anywhere else.",
          },
          auth: {
            type: "string",
            enum: ["bearer", "basic", "header"],
            description: "How it is usually attached (default bearer); each vault_lease can attach it differently. bearer (Authorization: Bearer <secret>), basic (username plus secret), or header (a named header such as PRIVATE-TOKEN).",
          },
          username: {
            type: "string",
            description: "For basic: the username to pair with the secret.",
          },
          header: {
            type: "string",
            description: "For header: the header's name.",
          },
        },
        required: ["name", "purpose", "hosts"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_lease",
      description:
        "Get a short-lived lease to use one stored credential from the workstation. With it, a request to $MIKE_VAULT_URL/<lease>/<host>/<path> in the workstation goes to https://<host>/<path> with the credential attached by the vault; the response tells you how, including for git. Leases work only from this user's workstation, only for the credential's hosts, and only until this turn ends: get a new one in a later turn. If the service rejects the credential (401), try the other ways it accepts it before asking the user to replace it. A read lease allows GET, HEAD and OPTIONS. A write lease also allows changes (POST, PUT, PATCH, DELETE, git push); unless the user has allowed changes for that credential, a write lease waits for their approval.",
      parameters: {
        type: "object",
        properties: {
          secret: { type: "string", description: "The stored credential's name." },
          access: {
            type: "string",
            enum: ["read", "write"],
            description: "read, or write to change something.",
          },
          reason: {
            type: "string",
            description: "For a write lease: what you will change, shown to the user when they approve.",
          },
          auth: {
            type: "string",
            enum: ["bearer", "basic", "header"],
            description: "How to attach the credential for this lease, when not the way it was stored. Services often take one token differently in different places: e.g. a GitLab personal access token goes in the PRIVATE-TOKEN header (or as bearer) for the API, and as basic auth with username oauth2 for git over HTTPS.",
          },
          username: { type: "string", description: "For basic: the username to pair with the secret." },
          header: { type: "string", description: "For header: the header's name." },
        },
        required: ["secret", "access"],
      },
    },
  },
];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "check_citations",
      description:
        "Check every citation in a document against its source: each case, statute, article or web page it cites is looked up (CourtListener, the web), stored as evidence, and judged by a separate checker on whether it exists, whether any quoted words are really in it, and whether it supports what the document uses it for. Slow and costs model calls for each citation, so use it when it matters: after drafting a document with citations, when its citations or substance change, and before the user sends it out; not after every small edit. Reads the document only. Tell the user about every citation it flags, above all any whose source contradicts what the document says, and fix those before calling the document done.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Chat-local ID of the document to check (e.g. 'doc-0').",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replicate_document",
      description:
        "Copy an available document, Library Template, or workflow asset without changing the source. In a project chat, copies are saved to Project Documents; otherwise they are saved to Library Files. Always use this before editing or drafting from a Library Template or workflow asset. For an ordinary document, use it only when the user specifically asks for a copy/duplicate or a new document based on that file. Returns new doc_id slugs for read_document and edit_document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "Chat-local ID of the source document, Library Template, or workflow asset.",
          },
          count: {
            type: "integer",
            description:
              "How many copies to create. Defaults to 1. Maximum 20.",
            minimum: 1,
            maximum: 20,
          },
          new_filename: {
            type: "string",
            description:
              "New base filename. Required for Library Templates and workflow assets. With count > 1, copies are numbered. The extension is forced to match the source.",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_inputs",
      description:
        'Ask the user for one or more decisions, open-ended answers, clarifications, or document uploads before continuing. Use this when guessing would materially affect the answer or when required documents have not been attached. Put all needed questions and document requests in one items array. Each item is {"id", "kind", "question", "options"}: kind "choice" when exactly one option should be selected, "multi_choice" when one or more may be, "text" when the user should type a free-form answer and there are no useful suggested options, and "documents" for uploads (with document_types instead of a question). Example: {"items": [{"id": "law", "kind": "choice", "question": "Which governing law?", "options": [{"value": "England and Wales"}, {"value": "New York"}]}, {"id": "party", "kind": "text", "question": "What is the counterparty\'s full legal name?"}]}. An item without a question, or a choice without options, is refused with an error and nothing is shown. Returns nothing: a valid call ends your turn, and the answers arrive in the user\'s next message; do not continue the substantive task until then. If the user skips some inputs, do not ask for them again; continue with what they gave you and mark each missing value in a draft with a descriptive placeholder in square brackets. If they skip every input, they have declined: do not start the substantive task on assumed defaults; say what you would need, or ask how they want to proceed.',
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              'The inputs needed before continuing, 1 to 12 objects of the form {"id", "kind", "question", "options"}. Use choice for exactly one selection, multi_choice for one or more selections, text for open-ended answers such as a name or address, and documents for required uploads.',
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short ID for this input, unique within this tool call.",
                },
                kind: {
                  type: "string",
                  enum: ["choice", "multi_choice", "text", "documents"],
                  description:
                    "choice (pick one), multi_choice (pick one or more), text (type an answer), or documents (attach files).",
                },
                question: {
                  type: "string",
                  description:
                    "Required for choice, multi_choice, and text items: the full, concise question the user reads.",
                },
                options: {
                  type: "array",
                  description:
                    'Required for choice and multi_choice items, 1 to 8 objects such as {"value": "New York"}. Each value is shown to the user and sent back if selected.',
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      value: {
                        type: "string",
                        description: "The user-facing choice text.",
                      },
                    },
                    required: ["value"],
                  },
                },
                allow_other: {
                  type: "boolean",
                  description:
                    "For choice and multi_choice items: whether to show an Other option with a text field. Defaults to true.",
                },
                other_label: {
                  type: "string",
                  description:
                    "For choice and multi_choice items: label for the free-text option. Defaults to Other.",
                },
                document_types: {
                  type: "array",
                  description:
                    "For documents items only: readable labels for the types of documents you need the user to attach.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "string",
                  },
                },
                response_prefix: {
                  type: "string",
                  description:
                    "Optional prefix the UI should include when sending this response back as the next message.",
                },
              },
              required: ["id", "kind"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the text content of an available document. Always call this before answering questions about, summarising, citing from, or editing a document. Word (.docx) documents read like a codebase: one block per line, starting with its id in brackets ([0000029F] or [p12]), then the clause number; a long document returns an outline and a first window, and you read further with section (a clause number or heading), from/to (block ids) or full. Other documents return line windows (offset/limit). Returns text, not JSON: a header naming the document, then the content; a partial read ends with a notice naming where to continue. A to past the end reads to the end. Do not repeat a read you already have; read a different part, or use find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "The document ID to read (e.g. 'doc-0', 'doc-1', or 'active-word-document')",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description:
              "1-based line to start from (default 1). Use the offset from a continuation notice to read the next window.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description:
              "Maximum number of lines to return (default 2000, max 5000).",
          },
          section: {
            type: "string",
            description:
              ".docx only: a clause number or heading to read, e.g. '16', '5.3.1(a)', 'Schedule 2'.",
          },
          from: {
            type: "string",
            description:
              ".docx only: block id to start reading at (from the outline, a find result, or a continuation notice).",
          },
          to: {
            type: "string",
            description: ".docx only: block id to stop after.",
          },
          full: {
            type: "boolean",
            description:
              ".docx only: return the whole document. Use only when you need all of it.",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_document",
      description:
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. For .docx, each match names its block id and clause number, which read_document (from) and edit_document (block) accept. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, defined term or cross-reference) rather than reading the whole document. Returns {\"ok\", \"filename\", \"query\", \"total_matches\", \"returned\", \"truncated\", \"hits\": [{\"index\", \"block_id\" and \"label\" (.docx) or \"excerpt\" (other files), \"context\"}]}.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description:
              "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of surrounding context to include on each side of a match (default 80).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_documents",
      description:
        "Search several documents at once for a string — find_in_document across the project. Returns, for each document with matches, how many there are and the first few with surrounding context (block ids and clause numbers for .docx). Use it to find which documents mention a party, term, figure or clause, and where, before reading anything; then read only the parts that matter. Matching is case-insensitive and whitespace-tolerant. Returns {\"ok\", \"query\", \"searched\", \"total_matches\", \"documents\": [{\"doc_id\", \"filename\", \"total_matches\", \"hits\": [as find_in_document]}], \"skipped\"}.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The string to search for.",
          },
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description: "Documents to search (e.g. ['doc-0', 'doc-3']). Omit to search every document available here.",
          },
          max_results_per_document: {
            type: "integer",
            description: "Matches to return from each document (default 5). The total count is always reported.",
          },
          context_chars: {
            type: "integer",
            description: "Characters of context on each side of a match (default 80).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_docx",
      description:
        "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns {\"doc_id\", ...}: the new document's doc_id for read_document; the user gets its card automatically.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Document title (used as filename and heading)",
          },
          landscape: {
            type: "boolean",
            description:
              "Set to true for landscape page orientation. Default is portrait.",
          },
          numberSections: {
            type: "boolean",
            description:
              "Apply legal numbering to section headings. Default is false. Set true only when the user explicitly requests numbered sections/clauses or a workflow, playbook, or source template requires them. Never use it for demand letters, ordinary letters, notices, memos, or reports unless numbering was requested.",
          },
          sections: {
            type: "array",
            description:
              "List of document sections. Each section may contain a heading, prose content, or a table.",
            items: {
              type: "object",
              properties: {
                heading: {
                  type: "string",
                  description: "Optional section heading",
                },
                level: {
                  type: "integer",
                  description: "Heading level: 1, 2, or 3",
                },
                content: {
                  type: "string",
                  description:
                    "Prose text content (paragraphs separated by double newlines). You can include footnotes using standard markdown syntax (cite with [^1] and define with [^1]: citation text, or supply via the footnotes parameter). Markdown links [text](url) and bare URLs are automatically compiled into native clickable Word hyperlinks in body text, footnotes, and tables.",
                },
                footnotes: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    "Optional section-level mapping of footnote IDs (e.g. \"1\", \"2\") to footnote citation text. In content, cite them with [^1], [^2].",
                },
                pageBreak: {
                  type: "boolean",
                  description:
                    "Set to true to start this section on a new page. Use for contract signature pages.",
                },
                table: {
                  type: "object",
                  description: "Optional table to render in this section",
                  properties: {
                    headers: {
                      type: "array",
                      items: { type: "string" },
                      description: "Column header labels",
                    },
                    rows: {
                      type: "array",
                      items: {
                        type: "array",
                        items: { type: "string" },
                      },
                      description:
                        "Array of rows, each row is an array of cell strings matching the headers order",
                    },
                  },
                  required: ["headers", "rows"],
                },
              },
            },
          },
          footnotes: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional document-wide mapping of footnote IDs (e.g. {\"1\": \"citation text\", \"2\": \"...\"}). In content, cite them using standard markdown footnotes [^1], [^2]. Footnotes render as genuine Word footnote fields at the bottom of the page.",
          },
        },
        required: ["title", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_excel",
      description:
        "Generate an Excel (.xlsx) workbook from structured sheet data. Use this when the user asks for a spreadsheet, tracker, matrix, checklist, schedule, or Excel file. Returns {\"doc_id\", ...}: the new document's doc_id for read_document; the user gets its card automatically.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Workbook title, used as the filename.",
          },
          sheets: {
            type: "array",
            description:
              "Workbook sheets. Each sheet has a name, columns, and rows. Row values should follow the columns order.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Sheet tab name. Keep it short.",
                },
                columns: {
                  type: "array",
                  items: { type: "string" },
                  description: "Column header labels.",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description:
                    "Array of rows, each row an array of cell strings matching the columns order.",
                },
              },
              required: ["name", "columns", "rows"],
            },
          },
        },
        required: ["title", "sheets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_ppt",
      description:
        "Generate a PowerPoint (.pptx) presentation from structured slides. Use this when the user asks for slides, a deck, presentation, or PowerPoint file. Returns {\"doc_id\", ...}: the new document's doc_id for read_document; the user gets its card automatically.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Presentation title, used as the filename.",
          },
          slides: {
            type: "array",
            description:
              "Slides in order. Each slide may have a title, bullets, and optional speaker notes.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Slide title.",
                },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Main bullet points for the slide. Keep each bullet concise.",
                },
                notes: {
                  type: "string",
                  description:
                    "Optional speaker notes. Included as text on a notes slide placeholder is not supported; use only for generation context.",
                },
              },
              required: ["title", "bullets"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_html",
      description:
        "Create an HTML page: an article, report or briefing that mixes prose, tables, images, embedded video and audio, and links. Use when the person wants something to read in a browser or to publish as a link; Word stays the default for legal drafts. Write one complete, self-contained document (<!doctype html>, <title>, inline <style>, readable on a phone). Media and fonts may load over https. Embed YouTube with https://www.youtube-nocookie.com/embed/<id> in an <iframe>, Vimeo with https://player.vimeo.com/video/<id>; use <audio controls> and <video controls> for files. Refer to the person's images and other documents in the same project by their filename as a relative path (e.g. <img src=\"site-plan.png\">); they are published with the page. Forms do not work on a published page. Returns {\"doc_id\", ...}; the person gets its card automatically and can publish it from the viewer.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Page title, used as the filename.",
          },
          html: {
            type: "string",
            description: "The complete HTML document.",
          },
        },
        required: ["title", "html"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description:
        "Propose edits to a user-attached .docx as tracked changes the user can accept or reject, in the web app or in Word. Edits target blocks by the ids read_document and find_in_document show; ids stay valid across versions, so an id read earlier still names the same paragraph. All edits in one call are checked against the document as you read it; if any edit fails, nothing is changed and every problem is reported. Formatting, footnotes, links and cross-references outside the changed words are kept. Each edit names its operation in op and carries that op's fields: replace {block, find, replace}; insert {after or before, paragraphs}; delete {block, through?}; format {block, find?, bold/italic/underline/strike/highlight/style/align}; insert_row {after or before, cells}; delete_row {block, through?}. Example: [{\"op\": \"insert\", \"after\": \"p12\", \"paragraphs\": [\"New clause text.\"]}, {\"op\": \"replace\", \"block\": \"p14\", \"find\": \"30 days\", \"replace\": \"45 days\"}]. Returns {\"ok\": true, \"doc_id\", \"version_id\", \"version_number\", \"applied\": <number of changes>, \"errors\": [...]} and shows one Accept/Reject card per edit, or {\"ok\": false, \"error\"} when nothing was applied.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
          edits: {
            type: "array",
            description:
              "The edits, each one of: replace (change words inside one paragraph), insert (add new paragraphs), delete (remove whole blocks: paragraphs, empty paragraphs, tables, or a range of them), format (bold/italic/underline/strike/highlight on words, or a paragraph's style or alignment), insert_row / delete_row (table rows). New text in replace, insert and insert_row may use **bold**, *italic*, [link text](https://…) for a new link, and {footnote: note text} for a new footnote at that point; write \\* for a literal asterisk.",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: ["replace", "insert", "delete", "format", "insert_row", "delete_row"],
                  description: "The operation. Unknown keys or ops are refused and nothing is applied.",
                },
                block: {
                  type: "string",
                  description:
                    "replace, delete, format, delete_row: the target block id, e.g. '0000029F'. For text in a table, or a table row, use the id of a paragraph inside the cell. Footnote text has its own ids, shown after the window.",
                },
                find: {
                  type: "string",
                  description:
                    "replace: the words to change, copied from the block's line, with enough around them to occur once in that block. Only what differs between find and replace becomes a tracked change. Tokens such as [^3], {ref 4.2} or [text](url) may be included; keep them unchanged in replace, or leave them out of replace to delete them. format: the words to format (default: the whole paragraph).",
                },
                replace: {
                  type: "string",
                  description:
                    "replace: the new text for find. An empty string deletes find. Wrapping unchanged words in **…** or *…* makes them bold or italic as a formatting change.",
                },
                after: {
                  type: "string",
                  description: "insert: block id to insert after. insert_row: id of a paragraph in the row to insert after, or a table id (after its last row).",
                },
                before: {
                  type: "string",
                  description: "insert, insert_row: as after, but before.",
                },
                paragraphs: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "insert: the new paragraphs' text, one string per paragraph. Do not type clause numbers that the document's list numbering provides.",
                },
                cells: {
                  type: "array",
                  items: { type: "string" },
                  description: "insert_row: one text per cell of the neighbouring row (\"\" for an empty cell).",
                },
                style: {
                  type: "string",
                  description:
                    "insert: paragraph style name for the new paragraphs (default: like the anchor paragraph). format: the new paragraph style.",
                },
                bold: { type: "boolean", description: "format: make the words bold (true) or not bold (false)." },
                italic: { type: "boolean", description: "format: italic on or off." },
                underline: { type: "boolean", description: "format: underline on or off." },
                strike: { type: "boolean", description: "format: strikethrough on or off." },
                highlight: {
                  type: "string",
                  description: "format: highlight colour (yellow, green, cyan, magenta, blue, red, darkBlue, darkCyan, darkGreen, darkMagenta, darkRed, darkYellow, darkGray, lightGray, black, white), or none to remove it.",
                },
                align: {
                  type: "string",
                  enum: ["left", "center", "right", "justify"],
                  description: "format: paragraph alignment.",
                },
                through: {
                  type: "string",
                  description:
                    "delete: last block id of a range to delete, in the same body, table cell or note as block. delete_row: a paragraph in the last row to delete.",
                },
                reason: {
                  type: "string",
                  description: "Short explanation shown to the user on the card.",
                },
              },
              required: ["op"],
            },
          },
        },
        required: ["doc_id", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diff",
      description:
        "Inspect the pending changes of an edited document before declaring completion: each change's deleted and inserted text, plus integrity checks (footnotes, relationships, revision structure). Call this after edit_document to confirm the changes match what the user asked for.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current or outside information on any subject: news, sports, prices, legal authorities, regulatory updates, company filings, market facts. Returns ranked results: {\"results\": [{\"title\", \"url\", \"snippet\"}], \"count\"}.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results to return (default: 5).",
          },
          provider: {
            type: "string",
            enum: ["keenable", "tavily", "exa", "parallel"],
            description: "Optional specific search provider override.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web_page",
      description:
        'Fetch an external web page or article as clean text, caching the snapshot for verified citations (egress guards apply). Returns one window of the text: {"url", "title", "content", "sha256", "offset", "returned_chars", "total_chars", "truncated", "next_offset", "note"}. A long page is cut at max_chars; when truncated is true and next_offset is present, call again with that offset to read on.',
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full HTTP/HTTPS URL of the web page to fetch.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Character offset to start from (default 0). Use next_offset from the previous result to continue.",
          },
          max_chars: {
            type: "integer",
            minimum: 1,
            maximum: 40000,
            description: "Most characters to return (default 12000, at most 40000).",
          },
        },
        required: ["url"],
      },
    },
  },
];
