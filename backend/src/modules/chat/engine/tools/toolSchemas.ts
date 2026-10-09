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
 * Everything else in the base set — read_document, find_in_document,
 * list_documents, fetch_documents, ask_inputs, the workflow and research
 * tools — only reads, so a collaborator who may talk in the thread keeps the
 * whole conversational surface.
 */
export const DOCUMENT_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit_document",
  "replicate_document",
  "generate_docx",
  "generate_excel",
  "generate_ppt",
]);

/** Read a tool schema's function name, whatever shape the entry arrived in. */
function toolName(tool: unknown): string | null {
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
        "Read the text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. Long documents return one bounded window at a time (default first 2000 lines); when a document's text ends with a continuation notice, call read_document with that doc_id and the offset it names to read further. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
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

export const WORKFLOW_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_workflows",
      description:
        "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The workflow ID to read",
          },
        },
        required: ["workflow_id"],
      },
    },
  },
];

export const TOOLS = [
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
        "Ask the user for one or more decisions, open-ended answers, clarifications, or document uploads before continuing. Use choice when exactly one option should be selected, multi_choice when one or more options may be selected, and text when the user should type a free-form answer and there are no useful suggested options. Use this when guessing would materially affect the answer or when required documents have not been attached. Put all needed questions and document requests in one items array. After calling ask_inputs, do not continue the substantive task until the user responds in a later message. If that response marks an input as skipped, do not ask for that input again; when drafting or editing a document, insert a descriptive placeholder in square brackets wherever the skipped value is required.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              "The list of user inputs needed before continuing. Use choice for exactly one selection, multi_choice for one or more selections, text for open-ended answers such as a name or address, and documents for required uploads.",
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
                },
                question: {
                  type: "string",
                  description:
                    "For choice, multi_choice, and text items: the concise question to show to the user.",
                },
                options: {
                  type: "array",
                  description:
                    "For choice and multi_choice items: selectable options to show. Each option has a single user-facing value, which is also sent back if selected.",
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
        "Read the text content of an available document. Always call this before answering questions about, summarising, citing from, or editing a document. Word (.docx) documents read like a codebase: one block per line, starting with its id in brackets ([0000029F] or [p12]), then the clause number; a long document returns an outline and a first window, and you read further with section (a clause number or heading), from/to (block ids) or full. Other documents return line windows (offset/limit). Do not repeat a read you already have; read a different part, or use find_in_document for targeted checks.",
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
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. For .docx, each match names its block id and clause number, which read_document (from) and edit_document (block) accept. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, defined term or cross-reference) rather than reading the whole document.",
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
      name: "generate_docx",
      description:
        "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
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
        "Generate an Excel (.xlsx) workbook from structured sheet data. Use this when the user asks for a spreadsheet, tracker, matrix, checklist, schedule, or Excel file. Returns a download URL for the generated file.",
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
        "Generate a PowerPoint (.pptx) presentation from structured slides. Use this when the user asks for slides, a deck, presentation, or PowerPoint file. Returns a download URL for the generated file.",
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
      name: "edit_document",
      description:
        "Propose edits to a user-attached .docx as tracked changes the user can accept or reject, in Mike or in Word. Edits target blocks by the ids read_document and find_in_document show; ids stay valid across versions, so an id read earlier still names the same paragraph. All edits in one call are checked against the document as you read it; if any edit fails, nothing is changed and every problem is reported. Formatting, footnotes, links and cross-references outside the changed words are kept. Returns one Accept/Reject card per edit.",
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
        "Search the web for current or outside information on any subject: news, sports, prices, legal authorities, regulatory updates, company filings, market facts. Returns ranked results with title, URL, and snippet.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          limit: {
            type: "number",
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
        "Fetch the full content of an external web page or article. Extracts clean text, caches the content snapshot for verified citations, and enforces SSRF/private-mode egress guards.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full HTTP/HTTPS URL of the web page to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
];
