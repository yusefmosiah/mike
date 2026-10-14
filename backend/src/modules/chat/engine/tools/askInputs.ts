/**
 * The one reading of a model's `ask_inputs` arguments, shared by the
 * dispatcher (which pauses the turn) and Auto Mode (which answers itself).
 *
 * The canonical item shape is the tool schema's (toolSchemas.ts): `kind`,
 * `question`, and `options` as `{value}` objects. Models also write obvious
 * variants — `type` for `kind`, `prompt`/`label`/`text` for `question`,
 * options as plain strings — and those are read as what they plainly mean.
 * Anything that still cannot become a real question is refused with an error
 * that shows the expected shape: a placeholder question ("Please choose an
 * option.", a lone "Continue" option) is never put in front of the user.
 */
import type { AskInputItem, AskInputOption } from "../types";

export const ASK_INPUT_KINDS = ["choice", "multi_choice", "text", "documents"] as const;
type AskKind = (typeof ASK_INPUT_KINDS)[number];

export const MAX_ASK_ITEMS = 12;
export const MAX_ASK_OPTIONS = 8;

/** The shape and an example, quoted in every refusal so the next call can be right. */
export const ASK_INPUTS_EXPECTED_SHAPE =
  'Each item is {"id": str, "kind": "choice" | "multi_choice" | "text" | "documents", "question": str, ' +
  '"options": [{"value": str}, ...]} — question is required for choice, multi_choice and text; ' +
  "options (1 to 8) only for choice and multi_choice; documents items take document_types: [str] instead of a question.";

export const ASK_INPUTS_EXAMPLE = JSON.stringify({
  items: [
    {
      id: "law",
      kind: "choice",
      question: "Which governing law should the agreement use?",
      options: [{ value: "England and Wales" }, { value: "New York" }],
    },
    { id: "party", kind: "text", question: "What is the counterparty's full legal name?" },
    { id: "nda", kind: "documents", document_types: ["Signed NDA"] },
  ],
});

const KIND_ALIASES: Record<string, AskKind> = {
  choice: "choice",
  single_choice: "choice",
  single: "choice",
  select: "choice",
  radio: "choice",
  option: "choice",
  options: "choice",
  multi_choice: "multi_choice",
  multiple_choice: "multi_choice",
  multichoice: "multi_choice",
  multi: "multi_choice",
  multi_select: "multi_choice",
  multiselect: "multi_choice",
  checkbox: "multi_choice",
  checkboxes: "multi_choice",
  text: "text",
  free_text: "text",
  freetext: "text",
  open: "text",
  open_text: "text",
  input: "text",
  string: "text",
  textarea: "text",
  short_text: "text",
  long_text: "text",
  documents: "documents",
  document: "documents",
  upload: "documents",
  uploads: "documents",
  file: "documents",
  files: "documents",
  document_upload: "documents",
};

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

const first = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
};

function optionValue(option: unknown): string {
  if (typeof option === "string" || typeof option === "number") return str(option);
  if (!option || typeof option !== "object" || Array.isArray(option)) return "";
  const row = option as Record<string, unknown>;
  return str(first(row, ["value", "label", "text", "title", "name", "option"]));
}

export type AskInputsParse =
  | { ok: true; items: AskInputItem[] }
  | { ok: false; error: string };

function describe(index: number, row: Record<string, unknown> | null): string {
  const id = row ? str(first(row, ["id", "name", "key"])) : "";
  return `item ${index + 1}${id ? ` ("${id.slice(0, 40)}")` : ""}`;
}

/**
 * Read `ask_inputs` arguments into the items the user will see, or explain
 * exactly which items are unusable. All-or-nothing: one bad item refuses the
 * call, because a question set with a hole in it is not what the model meant.
 */
export function parseAskInputs(args: Record<string, unknown>): AskInputsParse {
  let rawItems: unknown = first(args, ["items", "questions", "inputs"]);
  if (typeof rawItems === "string") {
    try {
      rawItems = JSON.parse(rawItems);
    } catch {
      /* reported below */
    }
  }
  const refuse = (problems: string[]): AskInputsParse => ({
    ok: false,
    error:
      `ask_inputs was not shown to the user: ${problems.join("; ")}. ` +
      `${ASK_INPUTS_EXPECTED_SHAPE} Example: ${ASK_INPUTS_EXAMPLE}`,
  });
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return refuse(["items must be a non-empty list of questions"]);
  }
  if (rawItems.length > MAX_ASK_ITEMS) {
    return refuse([`at most ${MAX_ASK_ITEMS} items fit in one call (got ${rawItems.length}); ask the most important ones`]);
  }

  const problems: string[] = [];
  const items: AskInputItem[] = [];
  const usedIds = new Set<string>();
  rawItems.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${describe(index, null)} is not an object`);
      return;
    }
    const row = raw as Record<string, unknown>;
    const where = describe(index, row);
    const rawKind = str(first(row, ["kind", "type", "input_type", "inputType"]))
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const rawOptions = first(row, ["options", "choices"]);
    const rawDocumentTypes = first(row, ["document_types", "documentTypes", "documents"]);
    let kind: AskKind | undefined = rawKind ? KIND_ALIASES[rawKind] : undefined;
    if (rawKind && !kind) {
      problems.push(`${where} has kind "${rawKind.slice(0, 40)}"; kind must be one of ${ASK_INPUT_KINDS.join(", ")}`);
      return;
    }
    if (!kind) {
      // No kind at all: read it from what the item carries.
      kind = Array.isArray(rawOptions) ? "choice" : Array.isArray(rawDocumentTypes) ? "documents" : "text";
    }
    const multiFlag = row.multiple === true || row.multi === true || row.allow_multiple === true;
    if (kind === "choice" && multiFlag) kind = "multi_choice";

    let id = str(first(row, ["id", "name", "key"])).slice(0, 80) || `${kind.replace("_", "-")}-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const responsePrefix = str(first(row, ["response_prefix", "responsePrefix"])).slice(0, 200);
    const prefix = responsePrefix ? { response_prefix: responsePrefix } : {};

    if (kind === "documents") {
      const documentTypes = (Array.isArray(rawDocumentTypes) ? rawDocumentTypes : [])
        .map(str)
        .filter(Boolean)
        .map((type) => type.slice(0, 300))
        .slice(0, MAX_ASK_OPTIONS);
      items.push({ id, kind: "documents", document_types: documentTypes, ...prefix });
      return;
    }

    const question = str(first(row, ["question", "prompt", "label", "text", "title", "message", "description"])).slice(0, 500);
    if (!question) {
      problems.push(`${where} has no question text (put the words the user should read in "question")`);
      return;
    }

    if (kind === "text") {
      items.push({ id, kind: "text", question, ...prefix });
      return;
    }

    const options: AskInputOption[] = [];
    const seen = new Set<string>();
    for (const option of Array.isArray(rawOptions) ? rawOptions : []) {
      const value = optionValue(option).slice(0, 500);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({ value });
    }
    if (options.length === 0) {
      problems.push(
        `${where} is a ${kind} with no usable options (give 1 to ${MAX_ASK_OPTIONS} options as [{"value": "..."}], or use kind "text" for a free-form answer)`,
      );
      return;
    }
    if (options.length > MAX_ASK_OPTIONS) {
      problems.push(`${where} has ${options.length} options; at most ${MAX_ASK_OPTIONS} fit`);
      return;
    }
    const otherLabel = str(first(row, ["other_label", "otherLabel"])).slice(0, 80) || "Other";
    const allowOther = first(row, ["allow_other", "allowOther"]) !== false;
    items.push({
      id,
      kind,
      question,
      options,
      allow_other: allowOther,
      other_label: otherLabel,
      ...prefix,
    });
  });

  if (problems.length > 0) return refuse(problems);
  return { ok: true, items };
}
