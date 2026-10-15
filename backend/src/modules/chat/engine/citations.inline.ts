import { normalizeCitation, type ParsedCitation } from "./citations";

// Inline citations: the model writes the source at the claim as
// `<cite doc="doc-3f9a1c2e" page="3">verbatim quote</cite>` and the server
// issues the `[n]` marker, so a marker cannot exist without its source. See
// docs/inline-citations.md. Everything here is pure; streaming.ts only feeds
// it deltas.

const OPEN = "<cite";
const CLOSE = "</cite>";
/** A tag still open after this many characters is dropped. */
export const MAX_CITE_TAG_CHARS = 2_000;
const MAX_QUOTES_PER_MARKER = 3;

export type CiteTag = { attrs: Record<string, string>; quote: string };

/**
 * Parse one complete `<cite ...>quote</cite>` element. Attributes are
 * `name="value"` pairs in any order; the quote is the element text, verbatim
 * (no entity decoding) apart from surrounding whitespace.
 */
export function parseCiteTag(raw: string): { tag: CiteTag } | { error: string } {
  if (!raw.startsWith(OPEN) || !raw.endsWith(CLOSE)) {
    return { error: "not a cite element" };
  }
  let end = -1;
  let inQuote = false;
  for (let i = OPEN.length; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ">" && !inQuote) {
      end = i;
      break;
    }
  }
  if (end < 0) return { error: "open tag never ends" };

  const attrText = raw.slice(OPEN.length, end);
  const attrs: Record<string, string> = {};
  const pair = /\s+([A-Za-z][\w-]*)="([^"]*)"/y;
  let pos = 0;
  for (;;) {
    pair.lastIndex = pos;
    const match = pair.exec(attrText);
    if (!match) break;
    if (match[1] in attrs) return { error: `duplicate attribute ${match[1]}` };
    attrs[match[1]] = match[2];
    pos = pair.lastIndex;
  }
  if (attrText.slice(pos).trim()) return { error: "unparseable attributes" };

  const quote = raw.slice(end + 1, raw.length - CLOSE.length).trim();
  if (!quote) return { error: "empty quote" };
  return { tag: { attrs, quote } };
}

type RawSource = { key: string; base: Record<string, unknown>; entry: Record<string, unknown> };

function tagSource(
  tag: CiteTag,
  isKnownDoc: (label: string) => boolean,
): RawSource | { error: string } {
  const { attrs, quote } = tag;
  const present = (["doc", "url", "case"] as const).filter((name) => name in attrs);
  if (present.length === 0) return { error: "no source attribute" };
  if (present.length > 1) return { error: "more than one source attribute" };

  if (present[0] === "doc") {
    const label = attrs.doc.trim();
    if (!isKnownDoc(label)) return { error: "unknown document label" };
    return {
      key: `doc:${label}`,
      base: { doc_id: label },
      entry: {
        quote,
        ...(attrs.page ? { page: attrs.page } : {}),
        ...(attrs.sheet ? { sheet: attrs.sheet } : {}),
        ...(attrs.cell ? { cell: attrs.cell } : {}),
      },
    };
  }
  if (present[0] === "url") {
    const url = attrs.url.trim();
    return { key: `url:${url}`, base: { url }, entry: { quote } };
  }
  if (!/^\d+$/.test(attrs.case.trim()) || Number(attrs.case) <= 0) {
    return { error: "invalid case id" };
  }
  if (attrs.opinion !== undefined && !/^\d+$/.test(attrs.opinion.trim())) {
    return { error: "invalid opinion id" };
  }
  return {
    key: `case:${Number(attrs.case)}`,
    base: { cluster_id: Number(attrs.case) },
    entry: {
      quote,
      ...(attrs.opinion !== undefined ? { opinion_id: Number(attrs.opinion) } : {}),
    },
  };
}

/**
 * Turn a run of adjacent tags into citations, numbered from `firstRef`. Tags
 * naming the same source share one citation (up to three quotes); tags naming
 * different sources become separate citations, so separate markers. A tag that
 * cannot be resolved is dropped (and reported) without affecting the others.
 */
export function citeGroupToCitations(
  tags: CiteTag[],
  firstRef: number,
  isKnownDoc: (label: string) => boolean,
  onDrop: (reason: string) => void = () => {},
): ParsedCitation[] {
  const groups = new Map<string, { base: Record<string, unknown>; entries: Record<string, unknown>[] }>();
  for (const tag of tags) {
    const source = tagSource(tag, isKnownDoc);
    if ("error" in source) {
      onDrop(source.error);
      continue;
    }
    const group = groups.get(source.key) ?? { base: source.base, entries: [] };
    if (group.entries.length < MAX_QUOTES_PER_MARKER) group.entries.push(source.entry);
    else onDrop("more than three quotes for one marker");
    groups.set(source.key, group);
  }

  const citations: ParsedCitation[] = [];
  for (const group of groups.values()) {
    const citation = normalizeCitation({
      ...group.base,
      ref: firstRef + citations.length,
      quotes: group.entries,
    });
    if (citation) citations.push(citation);
    else onDrop("source could not be resolved");
  }
  return citations;
}

type CodeState =
  | { kind: "none" }
  | { kind: "span"; len: number }
  | { kind: "fence"; len: number; openLine: boolean };

export type InlineCitationOutput = { text: string; citations: ParsedCitation[] };

/**
 * The streaming side: feed it the model's text delta by delta and it returns
 * the text to show and the citations issued by that delta. Output does not
 * depend on where the deltas were split. Within the answer's prose:
 *
 *  - a cite group is held back and replaced by `[n]` markers, numbered across
 *    every segment of the turn (the instance outlives `end()`);
 *  - once a marker has been issued, a bare `[n]` is escaped to `\[n\]` so
 *    it cannot pose as a citation;
 *  - fenced code and code spans are shown as written.
 *
 * `end()` closes a text segment: an unclosed tag is dropped, other held text
 * is released as written.
 */
export class InlineCitationStream {
  /** Why tags were dropped, for the turn's citation diagnostics. */
  readonly dropped: string[] = [];
  private nextRef = 1;
  private state: "text" | "tag" | "gap" | "skip" = "text";
  private out = "";
  private issued: ParsedCitation[] = [];

  // Text state. `pending` holds a possible tag prefix ("<ci"), a possible
  // bare marker ("[12") or a run of backticks until the next character
  // settles what it is.
  private pending = "";
  private code: CodeState = { kind: "none" };
  private lineBlank = true;
  private runAtLineStart = false;
  private prevChar = "";

  private tagRaw = "";
  private skipTail = "";

  // Gap state: the tag just closed; whitespace after it, and a possible next
  // tag, are held so an adjacent tag can join the same marker.
  private group: CiteTag[] = [];
  private gapWs = "";
  private gapHold = "";

  constructor(private readonly isKnownDoc: (label: string) => boolean) {}

  push(delta: string): InlineCitationOutput {
    for (const ch of delta) this.feed(ch);
    return this.take();
  }

  /** End of a text segment (tool call, end of answer, legacy block). */
  end(): InlineCitationOutput {
    if (this.state === "tag") {
      this.drop("tag still open when the text ended");
    } else if (this.state === "gap") {
      const held = this.gapHold;
      this.gapHold = "";
      this.releaseGroup();
      this.literal(held);
    } else if (this.state === "text" && this.pending) {
      if (this.pending[0] === "`") this.closeRun();
      else this.literal(this.pending);
      this.pending = "";
    }
    this.state = "text";
    this.pending = "";
    this.tagRaw = "";
    this.skipTail = "";
    this.group = [];
    this.gapWs = "";
    this.gapHold = "";
    this.code = { kind: "none" };
    this.lineBlank = true;
    this.prevChar = "";
    return this.take();
  }

  private take(): InlineCitationOutput {
    const result = { text: this.out, citations: this.issued };
    this.out = "";
    this.issued = [];
    return result;
  }

  private drop(reason: string) {
    this.dropped.push(reason);
  }

  private feed(ch: string) {
    if (this.state === "text") this.feedText(ch);
    else if (this.state === "tag") this.feedTag(ch);
    else if (this.state === "gap") this.feedGap(ch);
    else this.feedSkip(ch);
  }

  /** Write text that is shown as written. */
  private literal(text: string) {
    for (const ch of text) {
      this.out += ch;
      this.prevChar = ch;
      if (ch === "\n") {
        // A blank line ends a code span; a fence's opening line is over.
        if (this.lineBlank && this.code.kind === "span") this.code = { kind: "none" };
        if (this.code.kind === "fence") this.code.openLine = false;
        this.lineBlank = true;
      } else if (!/\s/.test(ch)) {
        this.lineBlank = false;
      }
    }
  }

  private closeRun() {
    const run = this.pending;
    const n = run.length;
    const code = this.code;
    if (code.kind === "fence") {
      if ((this.runAtLineStart || code.openLine) && n >= code.len) this.code = { kind: "none" };
    } else if (code.kind === "span") {
      if (n === code.len) this.code = { kind: "none" };
    } else if (this.runAtLineStart && n >= 3) {
      this.code = { kind: "fence", len: n, openLine: true };
    } else {
      this.code = { kind: "span", len: n };
    }
    this.pending = "";
    this.literal(run);
  }

  private feedText(ch: string) {
    if (this.pending) {
      const lead = this.pending[0];
      if (lead === "`") {
        if (ch === "`") {
          this.pending += ch;
          return;
        }
        this.closeRun();
      } else if (lead === "<") {
        const next = this.pending + ch;
        if (OPEN.startsWith(next)) {
          this.pending = next;
          return;
        }
        if (this.pending === OPEN && (/\s/.test(ch) || ch === ">")) {
          this.pending = "";
          this.state = "tag";
          this.tagRaw = OPEN + ch;
          return;
        }
        const held = this.pending;
        this.pending = "";
        this.literal(held);
      } else {
        if (/\d/.test(ch) && this.pending.length <= 10) {
          this.pending += ch;
          return;
        }
        // Once the turn has issued a marker, a hand-typed number could pose
        // as one. Before that it is left alone, so an answer in the legacy
        // block format keeps its markers.
        if (ch === "]" && this.pending.length > 1 && this.nextRef > 1) {
          const digits = this.pending.slice(1);
          this.pending = "";
          this.literal(`\\[${digits}\\]`);
          return;
        }
        const held = this.pending;
        this.pending = "";
        this.literal(held);
      }
    }

    if (ch === "`") {
      this.runAtLineStart = this.lineBlank;
      this.pending = "`";
    } else if (this.code.kind !== "none") {
      this.literal(ch);
    } else if (ch === "<") {
      this.pending = "<";
    } else if (ch === "[" && this.prevChar !== "\\") {
      this.pending = "[";
    } else {
      this.literal(ch);
    }
  }

  private feedTag(ch: string) {
    this.tagRaw += ch;
    if (this.tagRaw.endsWith(CLOSE)) {
      const parsed = parseCiteTag(this.tagRaw);
      if ("error" in parsed) this.drop(parsed.error);
      else this.group.push(parsed.tag);
      this.tagRaw = "";
      this.state = "gap";
      this.gapWs = "";
      this.gapHold = "";
    } else if (this.tagRaw.length > MAX_CITE_TAG_CHARS) {
      this.drop("tag open past the length limit");
      this.tagRaw = "";
      this.skipTail = "";
      this.state = "skip";
    }
  }

  // After an oversized tag, discard what is left of it: up to its closing
  // tag, or the end of the paragraph if the model never closes it.
  private feedSkip(ch: string) {
    this.skipTail = (this.skipTail + ch).slice(-CLOSE.length);
    if (this.skipTail.endsWith(CLOSE)) {
      this.state = "text";
    } else if (this.skipTail.endsWith("\n\n")) {
      this.state = "text";
      this.literal("\n\n");
    }
  }

  private feedGap(ch: string) {
    if (this.gapHold) {
      const next = this.gapHold + ch;
      if (OPEN.startsWith(next)) {
        this.gapHold = next;
        return;
      }
      if (this.gapHold === OPEN && (/\s/.test(ch) || ch === ">")) {
        this.gapHold = "";
        this.gapWs = "";
        this.state = "tag";
        this.tagRaw = OPEN + ch;
        return;
      }
      const held = this.gapHold;
      this.gapHold = "";
      this.releaseGroup();
      for (const c of held + ch) this.feedText(c);
      return;
    }
    if (/\s/.test(ch)) {
      this.gapWs += ch;
    } else if (ch === "<") {
      this.gapHold = "<";
    } else {
      this.releaseGroup();
      this.feedText(ch);
    }
  }

  /** The group is complete: issue its markers, then the whitespace after it. */
  private releaseGroup() {
    const citations = citeGroupToCitations(
      this.group,
      this.nextRef,
      this.isKnownDoc,
      (reason) => this.drop(reason),
    );
    this.nextRef += citations.length;
    this.issued.push(...citations);
    this.group = [];
    const ws = this.gapWs;
    this.gapWs = "";
    this.state = "text";
    this.literal(citations.map((citation) => `[${citation.ref}]`).join("") + ws);
  }
}
