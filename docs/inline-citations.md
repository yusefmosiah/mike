# Inline citations

Design for replacing the trailing `<CITATIONS>` block with citation tags the
model writes at the claim. Status: approved for implementation.

## Problem

Today the model writes markers `[1]`, `[2]` in its prose and, after the whole
answer, a `<CITATIONS>` JSON array matching every marker to a source
(`backend/src/modules/chat/engine/prompts.ts`, the CITATIONS section). The
prose streams to the reader as it is written; the block is parsed only after
the answer ends (`streaming.ts`, after `flushText()`).

That is long-range bookkeeping the model does by hand, and when it fails
nothing objects. An answer shipped with 21 markers and no block: every marker
rendered as plain `[n]` text (`frontend/.../message/citationUtils.ts` leaves
an unmatched marker as literal text), and the only trace was a `devLog`.

A second, related defect: document labels are positional (`doc-${i}` in
`buildDocContext`, `contextBuilders.ts`; and `toolDispatcher.ts` for
generated and replicated documents). A label in an earlier message names a
different file once an earlier document is removed or the list reorders.

## Goal

A marker cannot exist without its source. Not discouraged: impossible.

## Design

### 1. The model cites inline

The model writes the source at the claim, as a tag the reader never sees:

```
The notice period is 90 days <cite doc="doc-3f9a1c2e" page="3">ninety (90) days' written notice</cite>.
```

Forms (attribute order free, values in double quotes, the element text is the
verbatim quote):

| Source | Tag |
| --- | --- |
| Document page | `<cite doc="doc-…" page="3">quote</cite>` |
| Across a page break | `<cite doc="doc-…" page="41-42">before [[PAGE_BREAK]] after</cite>` |
| Unpaginated document | `<cite doc="doc-…">quote</cite>` |
| Spreadsheet | `<cite doc="doc-…" sheet="Sheet1" cell="B7:C9">cell value</cite>` |
| Web page | `<cite url="https://…">quote</cite>` (title comes from the server's snapshot) |
| Court opinion | `<cite case="123" opinion="456">quote</cite>` (CourtListener cluster and opinion ids, as the block uses today) |

One marker with several passages: adjacent tags, separated by nothing but
whitespace, form one marker with up to three quotes (the block's `quotes`
array today). They must name the same source; a group that names different
sources becomes separate markers.

The quote is taken verbatim from the element text; no entity decoding. The
quote cannot contain `</cite>`.

The model never writes a number. It must not type `[n]` itself.

### 2. The server issues the markers while streaming

In `streamVisibleContent` (`backend/src/modules/chat/engine/streaming.ts`),
alongside the existing hold-back for `<CITATIONS>`:

- Hold back a possible tag prefix (`<`, `<c`, … `<cite`) at the end of a
  delta, as the `<CITATIONS>` hold-back does today.
- From `<cite` until `</cite>`, hold the text back. On close, parse the tag.
  After a close, keep holding while only whitespace follows, so an adjacent
  tag joins the same marker; the first other character releases the group.
- A valid group gets the next ref (1, 2, 3… in order of appearance, across
  every text segment of the turn, including segments between tool calls).
  Stream `[n]` in its place (in the `content_delta` and in the stored
  `content` event), and emit `{type:"citations", status:"partial",
  citations}` with every citation so far, built through `createCitation` as
  the partial path does today, so the pill is clickable at once.
- Whitespace held between the closing tag and the next character is
  re-emitted after the marker; whitespace the model put before the tag stays
  where it was.
- A malformed tag (missing source attribute, unknown document label,
  empty quote, unparseable attribute) or a tag still open past 2,000
  characters is dropped with no marker and recorded in the turn's
  citation diagnostics (`devLog` now, as the block's are). A tag still open
  when the answer ends is dropped.
- Inside fenced code blocks (```` ``` ````) and inline code spans, `<cite`
  is literal text and `[n]` is left alone.
- A bare `[n]` the model types in prose is escaped to `\[n\]`, which
  Markdown renders as `[n]` and the frontend's marker pass
  (`preprocessCitations`) does not match. So a hand-typed number can never
  pose as a citation or point at the wrong one.

After the answer, verification runs as today (`verifyCitations`, then
`attachWebSnapshots`) over the citations the tags produced, and the
`status:"final"` event carries them.

The model's own text, tags included, stays in its conversation history, so
later turns see what it wrote.

### 3. Transition

During the transition the trailing block is still accepted: if a turn
produced no inline tags, parse the block as today. If it produced any, ignore
the block (its refs would collide). Remove the block path once inline tags
have run on staging without fallbacks for two weeks; leave a comment saying
so.

Out of scope for now, and must keep working unchanged: the Word add-in chat
(`modules/word-chat`, its own `WORD_CHAT_CITATIONS_SECTION` in
`wordPrompt.ts`) and tabular review (`modules/tabular`), which both pass
`buildCitations`. When `buildCitations` is set, do no inline-tag processing.

### 4. Stable document labels

Every chat uses `stableDocLabel` (`contextBuilders.ts`): `doc-` plus the
first eight hex digits of the document id, longer on a clash. Replace the
positional labels in `buildDocContext` and in `toolDispatcher.ts` (generated
documents, replicated documents) with it, sharing one `taken` set per chat.

Labels name documents, not versions: an edit does not rename a document. The
exact version a citation quotes is the server's to record, and document
citations already carry `version_id` (`createCitation`); versions are
immutable, so no content hash is needed for documents. Web citations keep
their snapshot's `content_sha256`.

### 5. The quote decides the source

In `verifyCitations`: when a document quote is not found in the document its
tag names, but is found in exactly one other document of the turn's
`docIndex`, attribute the citation to that document (and its version) and
mark it verified. Found in none, or in several: unverified, as today. A
transposed label cannot produce a wrong citation.

### 6. Prompt

Rewrite the CITATIONS section of `prompts.ts` for the tags: the table above,
one short example per form, and these rules only:

- Cite at the claim, with the exact label, URL or case ids you were given.
- The text inside the tag is copied verbatim from the source; keep it short
  (ideally 25 words or fewer).
- Never type a citation number or a `[n]`; the app numbers citations.
- Never mention document labels in prose.

Keep the existing guidance on `[Page N]` markers, spreadsheet cells and
merged ranges, page breaks, and not adding Markdown links or a "Sources" list
for web pages, reworded for tags. Update the citation instructions repeated in
tool results (`toolDispatcher.ts`, `documentOps.ts`) and the CourtListener
prompt (`courtlistenerTools.ts`) to match. Leave `wordPrompt.ts` alone.

## Wire format

Unchanged. The client still receives `[n]` in content and the same
`citations` events (`started` is no longer needed for inline tags; `partial`
and `final` are). No frontend change is required.

## Acceptance tests

- A tag split across deltas at every character position streams the same
  output.
- An answer with tags and no `<CITATIONS>` block produces a clickable marker
  per tag group, numbered 1..N in order of appearance, across tool-call
  segments.
- An answer with bare `[n]` and no tags produces no citations, and the
  stored text contains `\[n\]`.
- Adjacent tags for one source form one marker with their quotes; for two
  sources, two markers.
- A malformed tag and an unclosed tag produce no marker and no leaked tag
  text.
- `<cite` inside a code fence or code span is shown as written.
- A turn with no tags still parses a legacy block.
- Labels stay the same after an earlier document is removed.
- A quote found only in another document is re-attributed there.
- No `doc-` label appears in streamed or stored content from a tag.
- `buildCitations` paths (Word chat, tabular) behave exactly as before.

## Not changing

- Web page capture, snapshots and the reader panel.
- The citation side panel and verification statuses.
- Generated documents and footnotes (a later change).
