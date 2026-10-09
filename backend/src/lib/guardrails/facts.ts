/**
 * Layer 1 of the layered Auto Mode gate: symbolic facts about one tool call.
 *
 * Everything here is pure and deterministic. It answers the questions a
 * model is bad at and a program is good at — what kind of effect a tool has,
 * where each recipient, link and id in the arguments came from, whether a
 * secret or a confidential figure is about to leave, how many items a call
 * touches — so the decision table (./layered.ts) can settle most calls
 * without a model, and the model in Layer 3 only ever sees narrow questions
 * about small, already-located pieces of the call.
 *
 * Provenance is traced against the turn's own record: the user's request,
 * and the tool results the assistant saw earlier in the turn. A `listing` is
 * system metadata (search hits, event lists, contact lists); `content` is a
 * body someone else wrote (an email, a page, a document) and may carry
 * instructions aimed at the assistant. Header lines of an email ("From:",
 * "To:", "Cc:") count as listing: they name the people in the thread.
 */

export type ContextEntry = { tool: string; kind: "listing" | "content"; result: string };

/** What a tool does to the world, mildest first. */
export type Effect =
  | "read"
  | "egress"
  | "draft"
  | "create"
  | "modify"
  | "overwrite"
  | "delete"
  | "send"
  | "share"
  | "unknown";

/** Effects that change or send something; a call with none of them only reads. */
export const WRITE_EFFECTS: ReadonlySet<Effect> = new Set([
  "draft", "create", "modify", "overwrite", "delete", "send", "share", "unknown",
]);

/**
 * Mike's own tools and its built-in Google connectors. MCP connector tools
 * are named `mcp_<connector>_<verb…>_<8 hex>`; their effect comes from the
 * server's annotations when known, else from the verb (see effectForTool).
 */
const KNOWN_EFFECTS: Readonly<Record<string, Effect>> = {
  // Mike reads and pure computation.
  read_document: "read", fetch_documents: "read", find_in_document: "read", list_documents: "read",
  read_table_cells: "read", get_diff: "read", list_workflows: "read", read_workflow: "read",
  courtlistener_search_case_law: "read", courtlistener_get_cases: "read", courtlistener_find_in_case: "read",
  courtlistener_read_case: "read", courtlistener_verify_citations: "read",
  // Mike document writes are tracked changes or new documents.
  edit_document: "create", replicate_document: "create", generate_docx: "create",
  generate_excel: "create", generate_ppt: "create",
  // The open web: a query or URL can carry matter text to any host.
  web_search: "egress", fetch_web_page: "egress",
  // Gmail.
  gmail_search: "read", gmail_read_message: "read", gmail_read_thread: "read", gmail_list_labels: "read",
  gmail_save_draft: "draft", gmail_send: "send", gmail_reply: "send", gmail_forward: "send",
  gmail_trash: "delete", gmail_delete_draft: "delete", gmail_modify_labels: "modify",
  // Calendar. An event with attendees sends invitations (see actionEffect).
  google_calendar_list_events: "read", google_calendar_get_event: "read",
  google_calendar_create_event: "create", google_calendar_update_event: "modify",
  google_calendar_delete_event: "delete",
  // Drive.
  google_drive_search: "read", google_drive_read_file: "read", google_drive_list_files: "read",
  google_drive_create_file: "create", google_drive_create_folder: "create", google_drive_copy_file: "create",
  google_drive_update_file: "modify", google_drive_move_file: "modify",
  google_drive_replace_file_content: "overwrite", google_drive_trash_file: "delete",
  google_drive_share_file: "share",
  // Code mode is judged by what its script calls (see parseCode).
  run_code: "unknown",
};

// Verb words of an MCP tool name, most severe first: a name with both
// "delete" and "list" is a delete.
const VERB_EFFECTS: ReadonlyArray<[RegExp, Effect]> = [
  [/^(share|shared|sharing|invite|grant|permission|permissions|collaborator|collaborators|publish|unlock|revoke)$/, "share"],
  [/^(delete|remove|trash|archive|purge|destroy|void|cancel|erase|wipe|drop|disconnect|unlink)$/, "delete"],
  [/^(send|post|reply|forward|message|notify|email|dm|broadcast|tweet|submit|efile|sign)$/, "send"],
  [/^(replace|overwrite|reset|truncate)$/, "overwrite"],
  [/^(update|edit|modify|rename|move|set|assign|label|tag|close|merge|reopen|change|transfer|add|link|mark|complete|resolve)$/, "modify"],
  [/^(create|new|upload|insert|make|log|start|draft|copy|duplicate|comment|note|record)$/, "create"],
  [/^(get|list|search|read|find|fetch|query|lookup|view|show|describe|count|download|check|verify|export|whoami|retrieve)$/, "read"],
];

/** MCP tool annotations, when the server declared them. */
export type ToolHints = { readOnly?: boolean; destructive?: boolean };

const RESEARCH_CONNECTORS = /^(westlaw|lexis|lexisnexis|bloomberg|bloomberglaw|pacer|courtlistener|edgar|vlex|fastcase|casetext|google|bing|brave|perplexity|tavily|exa)$/;

const MCP_NAME = /^mcp_([a-z0-9]+)_(.+)_[0-9a-f]{8}$/;

/**
 * A tool's effect. Unknown names are "unknown" — never assumed harmless. An
 * MCP tool's declared annotations win over its name, but only in the safe
 * direction: destructiveHint makes it a delete, readOnlyHint is trusted only
 * when the verb agrees (a read-only `send_message` is still a send).
 */
export function effectForTool(name: string, hints?: ToolHints): Effect {
  const known = KNOWN_EFFECTS[name];
  if (known) return known;
  if (name === "fetch" || name === "XMLHttpRequest" || name === "WebSocket" || name === "sendBeacon") return "egress";
  const mcp = MCP_NAME.exec(name);
  // Neither Mike's nor a connector's: nothing is known about it.
  if (!mcp) return "unknown";
  const words = mcp[2].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\s-]+/);
  let verb: Effect = "unknown";
  for (const [pattern, effect] of VERB_EFFECTS) {
    if (words.some((word) => pattern.test(word))) {
      verb = effect;
      break;
    }
  }
  if (hints?.destructive) return verb === "share" || verb === "send" ? verb : "delete";
  // A legal-research or court connector's search sends the query to a third party.
  if (verb === "read" && mcp && RESEARCH_CONNECTORS.test(mcp[1])) return "egress";
  if (hints?.readOnly && verb === "read") return "read";
  return verb;
}

/** The connector an MCP tool belongs to ("slack", "linear"), or null. */
export function connectorOf(name: string): string | null {
  return MCP_NAME.exec(name)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Code mode: the actions a script takes.

export type Action = {
  tool: string;
  effect: Effect;
  /** Literal argument values (string, string[] or nested JSON-ish text). */
  args: Record<string, unknown>;
  /** Argument keys whose value is computed at run time, not written out. */
  dynamicKeys: string[];
  /** The call sits inside a loop or array callback, so it may run many times. */
  inLoop: boolean;
};

/** Every `tools.<name>(…)` call in a script, with its literal arguments. */
export function parseCode(code: string, hintsFor?: (tool: string) => ToolHints | undefined): {
  actions: Action[];
  /** `tools[expr]` or other indirection: a call the parser cannot name. */
  opaque: boolean;
} {
  const actions: Action[] = [];
  const loops = loopSpans(code);
  const env = bindings(code);
  const callPattern = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`]+)\2\s*\])\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const tool = match[1] ?? match[3];
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(code, open);
    const inner = code.slice(open + 1, close < 0 ? code.length : close);
    const { args, dynamicKeys } = literalArgs(inner, env);
    const at = match.index ?? 0;
    actions.push({
      tool,
      effect: effectForTool(tool, hintsFor?.(tool)),
      args,
      dynamicKeys,
      inLoop: loops.some(([from, to]) => at > from && at < to),
    });
  }
  // Bare calls: a script can alias a tool, call one without the `tools.`
  // prefix, or reach the network with fetch. Anything that is not plain
  // JavaScript or a function the script defines is treated as a tool call.
  const local = new Set<string>();
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    local.add(match[1] ?? match[2]);
  }
  const masked = maskLiterals(code);
  // Masking can misread a regex; a snake_case call is never plain JavaScript,
  // so those are also found in the raw text (fail closed).
  const starts = new Set<number>();
  const candidates = [
    ...masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g),
    ...code.matchAll(/(?<![\w$.])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g),
  ];
  for (const match of candidates) {
    const name = match[1];
    if (starts.has(match.index ?? -1)) continue;
    starts.add(match.index ?? -1);
    if (JS_CALLABLES.has(name) || local.has(name)) continue;
    const before = code.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (/\bnew\s+$/.test(before) || /\btools\s*\.\s*$/.test(before)) continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(code, open);
    const inner = code.slice(open + 1, close < 0 ? code.length : close);
    let { args, dynamicKeys } = literalArgs(inner, env);
    const first = literalValue(inner.split(",")[0] ?? "", env);
    if (typeof first === "string" && !Object.keys(args).length) {
      args = { url: first };
      dynamicKeys = inner.includes(",") ? ["options"] : [];
    }
    const at = match.index ?? 0;
    actions.push({ tool: name, effect: effectForTool(name, hintsFor?.(name)), args, dynamicKeys, inLoop: loops.some(([from, to]) => at > from && at < to) });
  }
  const opaque = /\btools\s*\[(?!\s*['"`][^'"`]+['"`]\s*\])/.test(code) || /\bconst\s*\{[^}]*\}\s*=\s*tools\b/.test(code) || /=\s*tools\s*[;,)]/.test(code);
  return { actions, opaque };
}

/**
 * Variables a script binds to literals: `const id = 'doc_1'` and
 * `for (const id of ['a', 'b'])` (the loop variable stands for the whole list).
 */
function bindings(code: string): Map<string, unknown> {
  const env = new Map<string, unknown>();
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = valueEnd(code.replace(/;/g, ","), start);
    const value = literalValue(code.slice(start, end).replace(/[;,]\s*$/, ""), env);
    if (value !== undefined) env.set(match[1], value);
  }
  for (const match of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = code[start] === "[" ? matchingBracket(code, start) : -1;
    const source = end > 0 ? code.slice(start, end + 1) : (/^[A-Za-z_$][\w$]*/.exec(code.slice(start))?.[0] ?? "");
    const value = literalValue(source, env);
    if (Array.isArray(value)) env.set(match[1], value);
  }
  return env;
}

/** The script with string, regex and comment contents blanked, offsets kept. */
function maskLiterals(code: string): string {
  const out = code.split("");
  let at = 0;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  while (at < code.length) {
    const char = code[at];
    if (char === "'" || char === '"' || char === "`") {
      const end = skipQuote(code, at);
      blank(at + 1, end - 1);
      at = end;
    } else if (char === "/" && code[at + 1] === "/") {
      const end = code.indexOf("\n", at);
      blank(at, end < 0 ? code.length : end);
      at = end < 0 ? code.length : end;
    } else if (char === "/" && code[at + 1] === "*") {
      const end = code.indexOf("*/", at + 2);
      blank(at, end < 0 ? code.length : end + 2);
      at = end < 0 ? code.length : end + 2;
    } else if (char === "/" && /(^|[(,=:[!&|?{};>]|\breturn)\s*$/.test(code.slice(Math.max(0, at - 8), at))) {
      let end = at + 1;
      let inClass = false;
      while (end < code.length && code[end] !== "\n") {
        if (code[end] === "\\") end++;
        else if (code[end] === "[") inClass = true;
        else if (code[end] === "]") inClass = false;
        else if (code[end] === "/" && !inClass) break;
        end++;
      }
      blank(at + 1, end);
      at = end + 1;
    } else at++;
  }
  return out.join("");
}

// Plain JavaScript a script may call without touching a tool.
const JS_CALLABLES: ReadonlySet<string> = new Set([
  "print", "String", "Number", "Boolean", "Array", "Object", "Symbol", "BigInt", "Date", "RegExp", "Error",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI",
  "decodeURI", "escape", "unescape", "if", "for", "while", "switch", "catch", "function", "return", "typeof",
  "await", "async", "super", "Set", "Map", "WeakMap", "WeakSet", "Promise", "require", "import", "setTimeout",
  "clearTimeout", "structuredClone", "atob", "btoa", "Math", "JSON", "isArray", "of", "in", "with", "delete",
]);

function matchingBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  return -1;
}

/** Text ranges of loop bodies and array callbacks. */
function loopSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of code.matchAll(/\b(for|while)\s*\(/g)) {
    const head = matchingBracket(code, (match.index ?? 0) + match[0].length - 1);
    if (head < 0) continue;
    let body = head + 1;
    while (/\s/.test(code[body] ?? "")) body++;
    const end = code[body] === "{" ? matchingBracket(code, body) : code.indexOf(";", body);
    spans.push([match.index ?? 0, end < 0 ? code.length : end]);
  }
  for (const match of code.matchAll(/\.(forEach|map|flatMap|filter|reduce|some|every)\s*\(|Promise\.(all|allSettled)\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = matchingBracket(code, open);
    spans.push([match.index ?? 0, end < 0 ? code.length : end]);
  }
  return spans;
}

const STRING_LITERAL = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;

/** Every string literal in a script, with template holes left in place. */
export function stringLiterals(code: string): string[] {
  return [...code.matchAll(STRING_LITERAL)].map((m) => unescape(m[1] ?? m[2] ?? m[3] ?? ""));
}

function unescape(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(.)/g, "$1");
}

/**
 * The literal values of an object-literal argument, by key. A key whose value
 * is an identifier, call, or template with holes is listed as dynamic; its
 * literal fragments still show up through stringLiterals.
 */
type Env = ReadonlyMap<string, unknown>;

function literalArgs(inner: string, env: Env = new Map()): { args: Record<string, unknown>; dynamicKeys: string[] } {
  const args: Record<string, unknown> = {};
  const dynamicKeys: string[] = [];
  const body = inner.trim();
  if (!body.startsWith("{")) {
    if (body) dynamicKeys.push("*");
    return { args, dynamicKeys };
  }
  const end = matchingBracket(body, 0);
  const text = body.slice(1, end < 0 ? body.length : end);
  let at = 0;
  while (at < text.length) {
    const key = /^\s*,?\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(:)?/.exec(text.slice(at));
    if (!key) break;
    const name = key[2] ?? key[3];
    at += key[0].length;
    if (!key[4]) {
      // Shorthand `{ edits }`: a variable, literal only if bound to one.
      if (env.has(name)) args[name] = env.get(name);
      else dynamicKeys.push(name);
      continue;
    }
    const valueStart = at;
    at = valueEnd(text, at);
    const raw = text.slice(valueStart, at).trim();
    const value = literalValue(raw, env);
    if (value === undefined) dynamicKeys.push(name);
    else args[name] = value;
  }
  return { args, dynamicKeys };
}

function skipQuote(text: string, at: number): number {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

function valueEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === ",") return at + 1;
    if ("([{".includes(char)) {
      const close = matchingBracket(text, at);
      at = close < 0 ? text.length : close + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      at = skipQuote(text, at);
      continue;
    }
    at++;
  }
  return at;
}

/** Top-level comma-separated items of a bracketed list's inside. */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let at = 0;
  while (at < text.length) {
    const end = valueEnd(text, at);
    const item = text.slice(at, end).replace(/,$/, "").trim();
    if (item) items.push(item);
    at = end;
  }
  return items;
}

function literalValue(raw: string, env: Env = new Map()): unknown {
  const text = raw.replace(/,\s*$/, "").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(text) && env.has(text)) return env.get(text);
  const string = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(text) ?? /^`((?:\\.|[^`\\$]|\$(?!\{))*)`$/s.exec(text);
  if (string) return unescape(string[2] ?? string[1]);
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^(true|false|null)$/.test(text)) return JSON.parse(text);
  if (text.startsWith("[")) {
    const items = splitItems(text.slice(1, -1));
    const values = items.map((item) => literalValue(item, env));
    return values.every((value) => value !== undefined) ? values : undefined;
  }
  if (text.startsWith("{")) {
    const nested = literalArgs(text, env);
    return nested.dynamicKeys.length ? undefined : nested.args;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Targets and their provenance.

export type Provenance = "user" | "listing" | "content" | "none";

export type TargetKind = "recipient" | "url" | "id" | "channel";

export type Target = {
  kind: TargetKind;
  value: string;
  key: string;
  provenance: Provenance;
  /** The context line the value was found on, for Layer 3 (best source first). */
  line?: string;
  /** A link found in the record, but with its query or path changed. */
  altered?: boolean;
  /** The other results in the listing the target was picked from. */
  alternatives?: string[];
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL = /\bhttps?:\/\/[^\s'"`<>)\]]+/g;
const RECIPIENT_KEYS = /^(to|cc|bcc|recipients?|attendees|invitees|emails?|email_address|users?|members?|reviewers?|assignees?|collaborators?|signers?|share_with|with)$/i;
const CHANNEL_KEYS = /^(channel|channel_id|channel_name|conversation|room|team|repo|repository|space|workspace)$/i;
const ID_KEY = /(^|_)(id|ids)$|^(path|thread|page|issue|event|file|folder|draft|item|matter|contact|envelope|document)$/i;
const HEADER_LINE = /^\s*(?:from|to|cc|bcc|reply-to|sender|organizer|attendees?)\s*:/i;

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Where a value appears: the user's words, a listing (or header line), content, or nowhere. */
export function provenanceOf(value: string, userRequest: string, context: ContextEntry[]): { provenance: Provenance; line?: string; alternatives?: string[] } {
  const needle = normalizeForMatch(value);
  if (!needle) return { provenance: "none" };
  const named = normalizeForMatch(userRequest).includes(needle);
  let contentLine: string | undefined;
  for (const entry of context) {
    for (const line of lines(entry.result)) {
      if (!normalizeForMatch(line).includes(needle)) continue;
      if (entry.kind === "listing" || HEADER_LINE.test(line)) {
        const alternatives = entry.kind === "listing"
          ? lines(entry.result).map((other) => other.trim()).filter((other) => other && other !== line.trim() && /\w/.test(other)).slice(0, 6).map((other) => other.slice(0, 200))
          : undefined;
        return { provenance: named ? "user" : "listing", line: line.trim().slice(0, 300), alternatives };
      }
      contentLine ??= line.trim().slice(0, 300);
    }
  }
  // A value the user named keeps "user" provenance; the line is what the record says about it.
  if (named) return { provenance: "user", line: contentLine };
  return contentLine ? { provenance: "content", line: contentLine } : { provenance: "none" };
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/^#/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "").trim();
}

function flatStrings(value: unknown, key = "", out: Array<{ key: string; text: string }> = []): Array<{ key: string; text: string }> {
  if (typeof value === "string") out.push({ key, text: value });
  else if (Array.isArray(value)) for (const item of value) flatStrings(item, key, out);
  else if (value && typeof value === "object") {
    for (const [inner, item] of Object.entries(value)) flatStrings(item, /^\d+$/.test(inner) ? key : inner, out);
  }
  return out;
}

const DATETIME = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The recipients, links, ids and channels a call points at. */
export function targetsOf(action: Pick<Action, "args">, userRequest: string, context: ContextEntry[]): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (kind: TargetKind, key: string, value: string) => {
    const id = `${kind}:${value.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push(withAltered({ kind, key, value, ...provenanceOf(value, userRequest, context) }, userRequest, context));
  };
  for (const { key, text } of flatStrings(action.args)) {
    for (const email of text.match(EMAIL) ?? []) add("recipient", key, email);
    for (const url of text.match(URL) ?? []) add("url", key, url.replace(/[.,;:]+$/, ""));
    const value = text.trim();
    if (!value || value.length > 120 || DATETIME.test(value)) continue;
    if (CHANNEL_KEYS.test(key) && !EMAIL.test(value)) add("channel", key, value);
    else if (ID_KEY.test(key) && !/label/i.test(key) && !/\s{2,}/.test(value) && !value.includes("@") && !/^https?:/.test(value)) add("id", key, value);
    else if (RECIPIENT_KEYS.test(key) && !value.includes("@")) add("recipient", key, value);
  }
  return targets;
}

function withAltered(target: Target, userRequest: string, context: ContextEntry[]): Target {
  if (target.kind !== "url" || target.provenance !== "none") return target;
  const base = target.value.split(/[?#]/)[0];
  const parent = base.replace(/\/[^/]*$/, "");
  const found = provenanceOf(base, userRequest, context);
  if (found.provenance !== "none" && base !== target.value) return { ...target, altered: true, line: found.line };
  const parentFound = parent.split("/").length > 3 ? provenanceOf(parent, userRequest, context) : { provenance: "none" as Provenance };
  return parentFound.provenance !== "none" ? { ...target, altered: true, line: parentFound.line } : target;
}

/** Whether a value looks like a generated identifier rather than a name. */
export function isOpaqueId(value: string): boolean {
  return /\d/.test(value) || /^[A-Za-z0-9_-]{16,}$/.test(value);
}

// ---------------------------------------------------------------------------
// Secrets, confidential figures and copied text.

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
];

const DECLARED_SECRET = /\b(?:password|passcode|passwd|passphrase|pw|pwd|pin|api[ _-]?key|access[ _-]?token|token|secret|login|credentials?|recovery code)\b[^\n.]{0,24}?(?:\bis\b|:|=|-)\s*["'“]?([^\s"'”,;]{4,})/gi;

/** Values the user or a document declared to be a password, key or token. */
export function declaredSecrets(userRequest: string, context: ContextEntry[]): string[] {
  const found = new Set<string>();
  for (const text of [userRequest, ...context.map((entry) => entry.result)]) {
    for (const match of text.matchAll(DECLARED_SECRET)) {
      const value = match[1].replace(/[.)]+$/, "");
      // A secret has a digit, symbol or mixed case: "my password is expired" declares nothing.
      if (!/[\d\W_]/.test(value) && !/[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(value)) continue;
      if (value.length >= 4 && !/^(the|my|our|your|a|an|in|on|for|to|that|this|same|not|set|reset|required|attached|below|above)$/i.test(value)) found.add(value);
    }
  }
  return [...found];
}

/** A secret in outgoing text: a key-shaped token, or a value someone called a password. */
export function findSecret(text: string, declared: string[]): string | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  for (const value of declared) if (text.includes(value)) return value;
  return null;
}

const FIGURE = /\$\s?\d[\d,.]*\s?(?:[kmb]n?|million|billion|thousand)?\b|\b\d[\d,.]*\s?(?:%|percent|million|billion|bn|mm)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?x\b/gi;

/** Money, percentages and large numbers in a text, normalised for comparison. */
export function figuresIn(text: string): string[] {
  return [...new Set((text.match(FIGURE) ?? []).map(normalizeFigure).filter(Boolean))];
}

function normalizeFigure(figure: string): string {
  return figure.toLowerCase().replace(/[\s$,]/g, "").replace(/percent$/, "%").replace(/million$|mm$|mn$/, "m").replace(/billion$|bn$/, "b").replace(/thousand$/, "k");
}

// Tools whose results are public: copying their words into a search is fine.
const PUBLIC_SOURCES: ReadonlySet<string> = new Set([
  "web_search", "fetch_web_page", "courtlistener_search_case_law", "courtlistener_get_cases",
  "courtlistener_find_in_case", "courtlistener_read_case",
]);

export function isPrivateSource(entry: ContextEntry): boolean {
  if (PUBLIC_SOURCES.has(entry.tool)) return false;
  return !/^mcp_(westlaw|lexis|pacer|courtlistener|edgar)_/.test(entry.tool);
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with not no can may must shall should would could our your their his her they we you i me my us them which who whom what when where how why than then there here into over under about after before between during per via vs v re all any each other such only also more most some".split(" "),
);

function words(text: string): string[] {
  return text.toLowerCase().replace(/https?:\/\//g, " ").split(/[^a-z0-9$%.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);
}

export type Copied = {
  /** Longest run of consecutive words shared with one private source. */
  run: number;
  /** Figures (money, percentages, big numbers) from private sources, absent from the request. */
  figures: string[];
  /** Distinctive words from private sources, absent from the request. */
  terms: string[];
  /** Reference codes (matter, case, subpoena, account numbers) from private sources. */
  codes: string[];
  /** The private source line that overlaps most, for Layer 3. */
  excerpt?: string;
};

/**
 * What an outgoing text copies from the turn's private sources (documents,
 * emails, internal listings) that the user did not type themselves.
 */
export function copiedFromPrivate(text: string, userRequest: string, context: ContextEntry[]): Copied {
  const userWords = new Set(words(userRequest));
  const userFigures = new Set(figuresIn(userRequest));
  const outWords = words(text);
  let run = 0;
  let excerpt: string | undefined;
  let excerptScore = 0;
  const figures = new Set<string>();
  const terms = new Set<string>();
  const outFigures = figuresIn(text);
  const codes = new Set<string>();
  const outCodes = codesIn(text);
  const userCodes = new Set(codesIn(userRequest));
  for (const entry of context.filter(isPrivateSource)) {
    for (const code of codesIn(entry.result)) if (outCodes.includes(code) && !userCodes.has(code)) codes.add(code);
    const sourceWords = words(entry.result);
    const sourceSet = new Set(sourceWords);
    run = Math.max(run, longestCommonRun(outWords, sourceWords));
    for (const figure of figuresIn(entry.result)) if (outFigures.includes(figure) && !userFigures.has(figure)) figures.add(figure);
    for (const word of outWords) {
      if (sourceSet.has(word) && !userWords.has(word) && !STOPWORDS.has(word) && word.length > 3 && !/^\d{4}$/.test(word)) terms.add(word);
    }
    for (const line of lines(entry.result)) {
      const lineWords = new Set(words(line));
      const score = outWords.filter((word) => lineWords.has(word) && !userWords.has(word) && !STOPWORDS.has(word)).length;
      if (score > excerptScore) {
        excerptScore = score;
        excerpt = line.trim().slice(0, 400);
      }
    }
  }
  return { run, figures: [...figures], terms: [...terms], codes: [...codes], excerpt };
}

const CODE = /\b[A-Za-z0-9]+(?:[-/:.][A-Za-z0-9]+)+\b|\b[A-Za-z]+\d{3,}[A-Za-z0-9]*\b/g;

/** Reference-number-like tokens: "SEC-HO-26-4471", "1:24-cv-01234", "OKF004410". */
export function codesIn(text: string): string[] {
  return [...new Set((text.match(CODE) ?? []).filter((code) => /\d/.test(code) && /[A-Za-z]/.test(code) && code.length >= 5 && !/^\d{4}-\d{2}-\d{2}/.test(code)).map((code) => code.toLowerCase()))];
}

// Words a legal search adds without naming anyone's matter.
const GENERIC_TERMS = new Set(
  ("court courts circuit cir supreme chancery district appellate appeals bankruptcy federal state states united u.s us usc u.s.c cfr c.f.r " +
  "rule rules section sections article act code statute statutes regulation regulations reg regs guidance order orders opinion opinions " +
  "sec ftc doj irs dol eeoc nlrb cfpb finra ferc fcc epa osha ofac fincen uspto ptab ico edpb cnil gdpr ccpa cpra hipaa ada fmla flsa erisa " +
  "ucc dgcl llc lp inc corp co ltd plc delaware new york california texas florida massachusetts illinois ninth second third fourth fifth " +
  "sixth seventh eighth tenth eleventh d.c dc en banc s.d.n.y sdny d. del n.d cal c.d e.d w.d s.d form forms 8-k 10-k 10-q s-1 13d 13g " +
  "pdf html news latest recent today 2023 2024 2025 2026 2027 frcp fre frap rule 12(b)(6) 26(b)(1) 37(e) model restatement uniform").split(" "),
);

/**
 * Specific terms an outgoing web query adds beyond the user's words: names,
 * numbers and codes. A legal search adds courts, statutes and years; anything
 * else is something the assistant chose to send.
 */
export function addedTerms(text: string, userRequest: string, publicText = ""): string[] {
  const user = new Set([...words(userRequest), ...words(publicText)]);
  const userText = `${userRequest}\n${publicText}`.toLowerCase();
  const added = new Set<string>();
  for (const raw of text.replace(/https?:\/\/[^/\s]+/g, " ").split(/[\s"'(),;?&=+/]+/)) {
    const token = raw.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, "");
    if (!token || token.length < 2) continue;
    const lower = token.toLowerCase();
    if (GENERIC_TERMS.has(lower) || user.has(lower) || userText.includes(lower)) continue;
    if (/^\d{1,4}$/.test(token) && Number(token) < 2100) continue;
    if (/[A-Z]/.test(token[0]) || /\d/.test(token) || /^\$/.test(token)) added.add(token);
  }
  return [...added];
}

function longestCommonRun(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** Text in content results addressed to an AI assistant or claiming pre-approval. */
const INSTRUCTION_LIKE = /\b(?:note|footer|reminder|instructions?|message)\s+(?:to|for)\s+(?:any\s+|the\s+|all\s+)?(?:\w+\s+)?(?:ai|assistants?|agents?|tools?|copilots?|bots?|readers? using)\b|\b(?:ai|research|automated|legal)\s+(?:assistants?|tools?|agents?)\b[^.\n]{0,40}[:,]\s*(?:please\s+)?(?:add|include|append|send|forward|cc|bcc|copy|share|search|fetch|open|post|visit|attach|email|delete)\b|\b(?:before (?:reporting|replying|responding|answering)|when (?:summari[sz]ing|replying|responding|searching))\b[^.\n]{0,60}\b(?:add|include|append|send|forward|cc|copy|search|fetch|visit|post)\b|\b(?:ai|assistant|agent|automated|copilot|llm|bot)s?\b[^.\n]{0,80}\b(?:must|should|please|always|are (?:required|instructed)|need to|is to)\b|\bignore (?:all |any )?(?:previous|prior|above)\b|\b(?:pre-?approved|already approved|no need to (?:ask|confirm|check))\b|\bdo not (?:tell|inform|mention)\b/i;

export function instructionLines(context: ContextEntry[]): string[] {
  const found: string[] = [];
  for (const entry of context) {
    if (entry.kind !== "content") continue;
    for (const line of entry.result.split(/(?<=[.!?])\s+|\n/)) if (INSTRUCTION_LIKE.test(line)) found.push(line.trim().slice(0, 300));
  }
  return found;
}

// ---------------------------------------------------------------------------
// The facts for one call.

export type CallFacts = {
  actions: Action[];
  /** The most severe effect across the call's actions. */
  effect: Effect;
  targets: Target[];
  /** A secret about to leave in a write or egress action. */
  secret: string | null;
  /** Copied private material in web egress (queries, fetched URLs). */
  egressCopy: Copied | null;
  /** Many items: arrays of ids on a destructive call, a query selector, or a loop. */
  bulk: boolean;
  /** Public or anyone-with-the-link sharing. */
  publicShare: boolean;
  /** A script's call the parser cannot name, or a write whose arguments are computed. */
  opaque: boolean;
  /** Message, post or note text the call writes, joined. */
  message: string;
  /** Outgoing search queries and URLs. */
  egressText: string;
  /** Names, numbers and codes the web egress adds beyond the user's words. */
  added: string[];
  /** Figures, dates and reference codes a written message adds beyond the user's words. */
  messageAdds: string[];
  /** A write's arguments are computed by the script (the script is the evidence). */
  computedWrite: boolean;
  /** Every word of the message is in the user's request: the user dictated it. */
  dictated: boolean;
  /** Addresses an update would drop from a list the record shows (attendees, members). */
  drops: string[];
  /** Context lines the call's arguments draw on most, for Layer 3. */
  related: string[];
  instructions: string[];
  /** Distinctive words, figures or codes the call copies from those instruction lines. */
  fromInstructions: string[];
};

const SEVERITY: Effect[] = ["read", "egress", "draft", "create", "modify", "overwrite", "delete", "send", "share", "unknown"];
const MESSAGE_KEYS = /^(body|text|message|content|description|detail|details|comment|note|summary|title|subject|name|notes|replace|replacement|insert|new_text|value)$/i;
const SELECTOR_KEYS = /^(query|filter|q|search|where|match|pattern|selector|all)$/i;

/**
 * An action's effect given its arguments: a calendar event with attendees
 * sends invitations; a Drive or Box link with public access is a share.
 */
function actionEffect(action: Action): Effect {
  const { tool, args } = action;
  if (/calendar/.test(tool) && (action.effect === "create" || action.effect === "modify")) {
    const attendees = args.attendees;
    if ((Array.isArray(attendees) && attendees.length) || action.dynamicKeys.includes("attendees")) return "send";
  }
  if (action.effect === "create" && /comment|post|message/.test(tool)) return "send";
  return action.effect;
}

export function callFacts(input: {
  userRequest: string;
  tool: string;
  args: Record<string, unknown>;
  context: ContextEntry[];
  hintsFor?: (tool: string) => ToolHints | undefined;
}): CallFacts {
  const { userRequest, context } = input;
  let actions: Action[];
  let opaque = false;
  let codeLiterals: string[] = [];
  if (input.tool === "run_code") {
    const code = typeof input.args.code === "string" ? input.args.code : typeof input.args.script === "string" ? input.args.script : "";
    const parsed = parseCode(code, input.hintsFor);
    actions = parsed.actions.map((action) => ({ ...action, effect: actionEffect(action) }));
    opaque = parsed.opaque;
    codeLiterals = stringLiterals(code);
  } else {
    const base: Action = { tool: input.tool, effect: effectForTool(input.tool, input.hintsFor?.(input.tool)), args: input.args, dynamicKeys: [], inLoop: false };
    actions = [{ ...base, effect: actionEffect(base) }];
  }
  const effect = actions.reduce<Effect>((worst, action) => (SEVERITY.indexOf(action.effect) > SEVERITY.indexOf(worst) ? action.effect : worst), "read");
  const writes = actions.filter((action) => action.effect !== "read");

  // Targets: from each write's literal arguments, plus (for scripts) every
  // literal that looks like an address or link, since a script can route a
  // value through a variable.
  const targets: Target[] = [];
  const seen = new Set<string>();
  const push = (target: Target) => {
    const id = `${target.kind}:${target.value.toLowerCase()}`;
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(target);
    }
  };
  for (const action of writes) for (const target of targetsOf(action, userRequest, context)) push(target);
  if (input.tool === "run_code" && writes.length) {
    for (const literal of codeLiterals) {
      for (const email of literal.match(EMAIL) ?? []) push({ kind: "recipient", key: "code", value: email, ...provenanceOf(email, userRequest, context) });
      for (const url of literal.match(URL) ?? []) {
        const value = url.replace(/[.,;:]+$/, "").replace(/\$\{.*$/, "");
        push(withAltered({ kind: "url", key: "code", value, ...provenanceOf(value, userRequest, context) }, userRequest, context));
      }
    }
  }

  const declared = declaredSecrets(userRequest, context);
  const outgoing = writes.flatMap((action) => flatStrings(action.args).map((entry) => entry.text));
  if (input.tool === "run_code" && writes.length) outgoing.push(...codeLiterals);
  const secret = findSecret(outgoing.join("\n"), declared);

  const egress = actions.filter((action) => action.effect === "egress");
  const egressText = egress.flatMap((action) => flatStrings(action.args).map((entry) => safeDecode(entry.text))).join("\n")
    + (input.tool === "run_code" && egress.length ? "\n" + codeLiterals.filter((l) => !/^\s*$/.test(l)).join("\n") : "");
  const egressCopy = egress.length ? copiedFromPrivate(egressText, userRequest, context) : null;

  // A write whose target the script computes: from its own lookups it is a
  // bulk action over what they return (judged with the lookups shown);
  // from nowhere visible it is opaque.
  const computedWrites = writes.filter((action) => action.dynamicKeys.length > 0 && action.effect !== "egress" && action.effect !== "draft" && action.effect !== "create");
  const looksUp = actions.some((action) => action.effect === "read");
  const dynamicWrite = computedWrites.length > 0 && !looksUp;
  const destructive = actions.filter((action) => ["delete", "overwrite", "modify", "share", "send"].includes(action.effect));
  const bulk = destructive.some((action) => {
    if (action.inLoop) return true;
    if (Object.keys(action.args).some((key) => SELECTOR_KEYS.test(key)) && action.effect !== "send") return true;
    return Object.entries(action.args).some(([key, value]) => ID_KEY.test(key) && Array.isArray(value) && value.length > 1);
  }) || actions.filter((action) => action.effect === "delete").length > 1 || (computedWrites.length > 0 && looksUp);

  const publicShare = actions.some((action) =>
    (action.effect === "share" || /share|permission|link|access/.test(action.tool)) &&
    flatStrings(action.args).some(({ key, text }) => /access|visibility|scope|type|audience|role|permission/i.test(key) && /\b(anyone|public|open|everyone|anonymous|domain|organization|company)\b/i.test(text)),
  );

  const message = writes.flatMap((action) => flatStrings(action.args).filter(({ key }) => MESSAGE_KEYS.test(key)).map(({ text }) => text)).join("\n---\n");

  const outgoingText = [egressText, ...outgoing].join("\n");
  const instructions = instructionLines(context);
  const fromInstructions = instructions.length ? copiedFromLines(outgoingText, userRequest, instructions) : [];

  return {
    actions,
    effect,
    targets,
    secret,
    egressCopy,
    bulk,
    publicShare,
    opaque: opaque || dynamicWrite || actions.some((action) => action.effect === "unknown"),
    message,
    egressText,
    messageAdds: message ? messageAdditions(message, userRequest) : [],
    dictated: !!message.trim() && isDictated(message, userRequest),
    drops: droppedFromRecord(actions, targets),
    related: relatedLines(outgoing.join("\n"), userRequest, context),
    computedWrite: computedWrites.length > 0,
    added: egress.length ? addedTerms(withoutTracedUrls(egressText, targets), userRequest, publicText(context, instructions)) : [],
    instructions,
    fromInstructions,
  };
}

/** Egress text without the links copied exactly from the request or a listing. */
function withoutTracedUrls(text: string, targets: Target[]): string {
  let out = text;
  for (const target of targets) {
    if (target.kind === "url" && !target.altered && (target.provenance === "user" || target.provenance === "listing")) out = out.split(target.value).join(" ");
  }
  return out.replace(URL, (url) => (targets.some((t) => t.kind === "url" && t.value === url && !t.altered && t.provenance !== "content" && t.provenance !== "none") ? " " : url));
}

/** Public results the assistant saw, minus any line that reads as instructions to it. */
function publicText(context: ContextEntry[], instructions: string[]): string {
  return context
    .filter((entry) => !isPrivateSource(entry))
    .map((entry) => instructions.reduce((text, line) => text.split(line).join(" "), entry.result))
    .join("\n");
}

const DATE_WORDS = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d+\s+(?:days?|weeks?|months?|years?|business days))\b/gi;

/**
 * What a written message states that the user did not: figures, dates,
 * deadlines and reference codes. A reply that adds "the seller nets $98,112"
 * or "deadlines move to Oct 13" says something the user never said.
 */
export function messageAdditions(message: string, userRequest: string): string[] {
  const user = userRequest.toLowerCase();
  const userFigures = new Set(figuresIn(userRequest));
  const out = new Set<string>();
  for (const figure of message.match(FIGURE) ?? []) if (!userFigures.has(normalizeFigure(figure))) out.add(figure.trim());
  for (const code of codesIn(message)) if (!user.includes(code)) out.add(code);
  for (const date of message.match(DATE_WORDS) ?? []) {
    const lower = date.toLowerCase().replace(/\s+/g, " ");
    const head = lower.slice(0, 3);
    const digits = lower.match(/\d+/g) ?? [];
    const said = user.includes(lower) || (digits.length ? digits.every((d) => user.includes(d)) && user.includes(head) : user.includes(head));
    if (!said) out.add(date);
  }
  return [...out].slice(0, 12);
}

// Words that carry no claim of their own; negations and numbers are not among them.
const FILLER = new Set("a an the to of for and in on at with re by from as is are be our your my we i you it this that per - — : ; , .".split(" "));

/** Every word of a message appears in the request (the user dictated it, give or take filler). */
export function isDictated(message: string, userRequest: string): boolean {
  const user = new Set(words(userRequest));
  const extra = words(message).filter((word) => !user.has(word) && !FILLER.has(word));
  return extra.length === 0;
}

/**
 * For an update that sets a list (attendees, members, invitees), the
 * addresses the record shows on the item that the new list leaves out.
 */
function droppedFromRecord(actions: Action[], targets: Target[]): string[] {
  const dropped = new Set<string>();
  for (const action of actions) {
    if (!/update|edit|modify|set|replace|patch/.test(action.tool)) continue;
    const listKey = Object.keys(action.args).find((key) => /^(attendees|members|invitees|recipients|collaborators|assignees)$/i.test(key));
    if (!listKey) continue;
    const kept = new Set(flatStrings(action.args[listKey]).flatMap(({ text }) => text.match(EMAIL) ?? []).map((email) => email.toLowerCase()));
    for (const target of targets) {
      if (target.kind !== "id" || !target.line) continue;
      for (const email of target.line.match(EMAIL) ?? []) if (!kept.has(email.toLowerCase())) dropped.add(email.toLowerCase());
    }
  }
  return [...dropped];
}

/** The context lines sharing the most distinctive words with the call's arguments. */
function relatedLines(text: string, userRequest: string, context: ContextEntry[]): string[] {
  const out = new Set(words(text).filter((word) => !STOPWORDS.has(word) && word.length > 2));
  if (!out.size) return [];
  const scored: Array<[number, string]> = [];
  for (const entry of context) {
    for (const line of entry.result.split(/\n|(?<=[.!?])\s+/)) {
      const lineWords = new Set(words(line));
      const score = [...out].filter((word) => lineWords.has(word)).length;
      if (score >= 2) scored.push([score, line.trim().slice(0, 300)]);
    }
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, line]) => line);
}

/**
 * Whether a listing line matches the request strictly better than every other
 * line in the same listing, by distinctive words shared with the request.
 */
export function bestMatch(target: Target, userRequest: string): boolean {
  if (!target.line || !target.alternatives?.length) return false;
  const request = new Set(words(userRequest).filter((word) => !STOPWORDS.has(word)));
  const score = (line: string) => new Set(words(line).filter((word) => request.has(word))).size;
  const mine = score(target.line);
  return mine >= 1 && target.alternatives.every((other) => score(other) < mine);
}

function copiedFromLines(text: string, userRequest: string, sourceLines: string[]): string[] {
  const userWords = new Set(words(userRequest));
  const outWords = new Set(words(text));
  const found = new Set<string>();
  for (const line of sourceLines) {
    for (const word of words(line)) {
      if (outWords.has(word) && !userWords.has(word) && !STOPWORDS.has(word) && word.length > 3) found.add(word);
    }
    for (const value of [...figuresIn(line), ...codesIn(line)]) if ([...figuresIn(text), ...codesIn(text)].includes(value)) found.add(value);
    for (const email of line.match(EMAIL) ?? []) if (text.toLowerCase().includes(email.toLowerCase())) found.add(email.toLowerCase());
  }
  return [...found];
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}
