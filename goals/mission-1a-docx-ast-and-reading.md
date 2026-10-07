---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: 4f11860
  verdict: accept
  evidence_ref: goals/STATUS.md

finish:
  deliver: >-
    A preservation-first document model for .docx and coding-agent-style
    segmented reading built on it. The model is a map over the original XML,
    not a replacement: unmodified parts and nodes are carried through
    byte-for-byte, and the addressable view (blocks with IDs, inline tokens,
    computed clause numbers) points back at exact source ranges.
  artifact: >-
    backend/src/lib/docx/ (package, XML source map, view, numbering) and a
    segmented read_document / find_in_document for .docx in
    backend/src/modules/chat/engine/tools/.
  acceptance:
    - action: npm test --prefix backend -- src/lib/docx/
      proves: >-
        On every Word-authored file in src/__tests__/fixtures/docx/: (1) load
        then save with no edits reproduces every zip entry byte-identical;
        (2) every block's source range slices back to exactly that element's
        XML; (3) the view's text for each paragraph matches an independent
        extraction; (4) footnote/endnote references, fields, hyperlinks, tabs,
        breaks, content controls and existing tracked changes appear as
        tokens, never vanish.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/lib/docx/__tests__/numbering.oracle.test.ts
      proves: >-
        Computed clause labels match Word's own rendering: for every
        `REF <bookmark> \r` field in the corpus, the label computed for the
        bookmarked paragraph equals the field's cached result text (what Word
        displayed when it last saved). Reported as matched/total; the bar is
        stated in the receipt, not chosen after the run.
      evidence_class: local_test
    - action: segmented read probe on uk-msc-consolidated-schedules-v2.2a.docx through the real tool dispatcher
      proves: >-
        read_document without a flag returns an outline and a bounded window
        with block IDs and clause labels; a section read by clause number
        returns that clause; find returns block IDs; full=true is required to
        get everything.
      evidence_class: local_probe

value:
  better_means: >-
    The model can navigate a 12,000-paragraph contract the way a coding agent
    navigates a repository: outline, jump, read a window, search, and refer to
    clauses by the numbers lawyers use.
  goodharting_would_be: >-
    Tests against hand-written XML snippets; a view that drops what it cannot
    render; clause labels checked against our own expectations instead of
    Word's output.

boundaries:
  must_preserve:
    - Unmodified package parts byte-identical after save.
    - The view never silently drops a non-text element; unknown elements become opaque tokens.
    - Existing non-.docx read paths (PDF, spreadsheets, text) keep their current behavior.
    - Prompt-injection spotlighting and per-turn read guards in the read path.
  excluded:
    - Editing (Mission 1b) and version history (Mission 1c).
    - Headers, footers and text boxes as edit targets; they are read-only tokens here.
    - Frontend changes.

now:
  status: working
  slice: package-and-source-map
  blocker_or_risk: >-
    Clause labels depend on numbering.xml semantics (style-inherited numPr,
    lvlOverride, restarts); the REF oracle measures how close we are.
  next_action: Build the package layer and XML source map; prove byte-identical round-trip on the corpus.

receipts: []
---

# Mission 1a: Document Model and Segmented Reading

Part of Mission 1 in [`goals/STATUS.md`](STATUS.md). 1b (editing) and 1c
(versioning) build on this model.

## Design

- **Package:** the zip is read once. Each part keeps its original bytes;
  only a part that is edited is re-serialized, and within it only the edited
  element's source range is replaced (1b). Saving with no edits returns the
  original entries unchanged.
- **Source map:** a position-tracking scan of `word/document.xml` (and notes
  parts) records the exact `[start, end)` offsets of each body block,
  paragraph, run and inline element. The view is built from these offsets, so
  every view node can be traced back to its XML.
- **View:** an ordered list of blocks (paragraphs, tables with rows and cells
  of paragraphs, section breaks). Paragraph content is text plus inline
  tokens: `[^n]` footnote/endnote references, `{ref …}` and other fields
  (showing the cached result), links, tabs, breaks, content controls,
  existing insertions/deletions, and an opaque token for anything else.
- **Clause labels:** list numbering is computed from `numbering.xml` and
  styles (direct and style-inherited `numPr`, levels, formats, overrides,
  restarts), so a block can be addressed as "12.3(b)".
- **IDs:** opaque, stable for a given version. Word's `w14:paraId` is used
  when present and unique; otherwise an ordinal. Carrying IDs across
  versions is 1b/1c.
- **Reading:** `read_document` on a .docx returns an outline and a bounded
  window by default, accepts a block range or a clause label, and needs
  `full: true` for the whole document. `find_in_document` returns block IDs
  and labels.
