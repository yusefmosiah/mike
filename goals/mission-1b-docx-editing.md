---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: 0b7e1f0
  verdict: accept
  evidence_ref: goals/STATUS.md

finish:
  deliver: >-
    Tracked-change editing of .docx built on the Mission 1a document model.
    Edits address blocks by the IDs read_document shows, change only the runs
    they touch, keep formatting, footnote references, hyperlinks and fields,
    and are reversible in Word. A batch applies completely or not at all, and
    a version is activated only after the result passes the linter.
  artifact: >-
    backend/src/lib/docx/ (patch, edit, revisions), edit_document rebuilt on
    it in backend/src/modules/chat/engine/tools/, accept/reject in
    backend/src/modules/documents/ on the same engine, and one rewritten
    editing section of the system prompt.
  acceptance:
    - action: npm test --prefix backend -- src/lib/docx/__tests__/revisions.oracle.test.ts
      proves: >-
        The accept-all / reject-all engine reproduces the reference results:
        for every RevisionProcessor fixture with an -Accepted or -Rejected
        twin, the canonical form (paragraphs, text, run formatting, tokens)
        of our result equals the twin's. Mismatches are listed with reasons,
        and the list is fixed before the run.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/lib/docx/__tests__/edit.corpus.test.ts
      proves: >-
        On the long legal documents and the feature fixtures: (1) every
        package part other than the edited ones is byte-identical, and in an
        edited part every element outside the edited blocks is byte-identical;
        (2) reject-all of the edited document equals reject-all of the
        original, run formatting included; (3) accept-all equals the original
        with exactly the requested change applied; (4) footnote references,
        hyperlinks and fields outside the changed text survive; (5) the
        result reloads, lints clean, and LibreOffice converts it.
      evidence_class: local_test
    - action: edit probe on uk-msc-core-terms-v2.2a.docx through the real tool dispatcher
      proves: >-
        read_document, then edit_document with a replace, an insert, a range
        delete across a table, and an empty-paragraph delete in one batch;
        get_diff shows them; accepting one and rejecting another through the
        documents service gives the right text; a batch with one bad target
        changes nothing.
      evidence_class: local_probe

value:
  better_means: >-
    A lawyer can let the model mark up a real contract: the redline keeps the
    document's formatting and cross-references, each change can be accepted
    or rejected in Word or in Mike, and rejecting everything gives back the
    original.
  goodharting_would_be: >-
    Tests on hand-written XML; checking only plain text after accept;
    "formatting preserved" meaning the paragraph style survived while run
    formatting was flattened.

boundaries:
  must_preserve:
    - Unedited package parts and unedited elements byte-identical.
    - Existing tracked changes by other authors are never silently accepted or rejected by an edit.
    - Per-turn version reuse, read guards, and the edit card flow in the UI.
    - Authorization and project-sharing checks on accept/reject.
  excluded:
    - Carrying block IDs across versions (Mission 1c). IDs are stable within a batch and across the batches of one turn.
    - Formatting changes (bold, styles) as edits; table row/column insertion; moves.
    - Headers, footers and text boxes as edit targets.
    - The Word add-in edit path (word_document_edits).

now:
  status: awaiting_owner_review
  slice: complete-pending-review
  blocker_or_risk: >-
    Verified against the PowerTools reference results and LibreOffice, not
    against Microsoft Word itself. The owner should open sample edited
    documents in Word and use Accept All / Reject All before signing off.
  next_action: Owner review; then Mission 1c (block ids across versions).

receipts:
  - action: npm test --prefix backend -- src/lib/docx/__tests__/revisions.oracle.test.ts
    result: "107 passed (107). 101 references match exactly; 6 listed before the run as known differences, each a reference defect confirmed by inspection (empty tables, moved-paragraph marks, cell gridSpan, a reject twin from another source)."
  - action: MIKE_LIBREOFFICE_TESTS=1 npm test --prefix backend -- src/lib/docx/__tests__/edit.corpus.test.ts
    result: "34 passed (34): 7 edit-model invariants over every paragraph of 7 documents, 24 edits on Word-authored files (MSC core terms and schedules, EPA CRADA, academy transfer agreement, PowerTools footnote/tracked-revision files), 3 batch/atomicity checks, and LibreOffice's own accept-all/reject-all of all 24 edited documents."
  - action: cd backend && npx tsx scripts/probe-docx-editing.ts (local stack: docker compose up -d db auth rest gateway db-init mailpit storage createbucket)
    result: "PROBE PASSED: 15/15 checks. One edit_document batch (replace, insert, range delete across a table, empty-paragraph delete) through runToolCalls on uk-msc-core-terms-v2.2a.docx; get_diff listed 4 changes, lint valid; accept and reject through documents.service; a batch with one bad block id created no version."
  - action: npm test --prefix backend
    result: "4215 passed, 51 skipped, 0 failed."
---

# Mission 1b: Tracked-Change Editing

Part of Mission 1 in [`goals/STATUS.md`](STATUS.md). Builds on
[Mission 1a](mission-1a-docx-ast-and-reading.md).

## Design

- **Patch layer:** edits are expressed against the scanned element tree as
  remove / replace / unwrap / rename / insert operations. Serializing walks
  only the elements on a path to an operation; every other subtree is copied
  from the source slice, so untouched XML stays byte-identical.
- **Edit operations** (one clear path per kind of edit), each targeting a
  block ID from `read_document` or `find_in_document`:
  - `replace` `{block, find, replace}`: change text inside one paragraph
    (body, table cell or footnote). `find` is copied from the rendered line
    and must occur once in it. Only the differing middle becomes a tracked
    change. Runs are split at the change boundaries, and each piece keeps its
    own run properties. Inserted text takes the formatting of the text it
    continues. Tokens (`[^3]`, `{ref 4.2}`, `{image}`, link markup) may be
    deleted whole but never split or typed.
  - `insert` `{after | before, paragraphs, style?}`: new paragraphs as
    tracked insertions, with the anchor's paragraph properties unless a
    style is given.
  - `delete` `{block, through?}`: whole blocks as tracked deletions:
    paragraphs (empty ones included), tables (as deleted rows), or a range of
    sibling blocks spanning both. Paragraph marks are deleted the way Word
    does it (the last mark in a container is kept and the previous one is
    deleted instead).
- **Batches:** every operation resolves against the document as read, before
  anything changes, so earlier operations cannot shift later targets. Any
  failure rejects the whole batch with every error listed.
- **Gate:** the result is re-scanned, reloaded through the view, and linted
  (package, notes, relationships, revision structure) before a version is
  created or overwritten. A failure creates nothing.
- **Revisions engine:** accept / reject by revision ID or all at once,
  covering run insertions and deletions, paragraph-mark revisions (with
  paragraph merge), table-row revisions, field codes, and formatting-change
  records. The UI's per-card accept/reject and the test oracle use the same
  code.
- **IDs:** Word `w14:paraId` where unique; otherwise ordinals counted only
  over original paragraphs, so inserted paragraphs do not shift the IDs of
  later ones within a turn.

## What was verified, and how

- **Reference results:** the accept/reject engine is checked against the
  Open-XML-PowerTools RevisionProcessor references. Every Word-authored file
  in the corpus passes the linter's revision-structure checks; the only
  files that fail are three reference outputs that leave tables without rows.
- **An independent reader:** LibreOffice (headless, UNO) opens every edited
  document, applies its own Accept All / Reject All, and must agree with us:
  reject-all gives back the original's text, and accept-all changes the text
  exactly as our engine does.
- **Byte preservation:** for every edit, unedited parts are byte-identical
  and every top-level element outside the edited blocks appears verbatim.

## Known differences and limits

- LibreOffice keeps an empty paragraph when a deleted paragraph sits directly
  before a table; Word and our engine remove it. LibreOffice also keeps the
  text of RA001's own deleted table rows after Accept All. Both are noted in
  the test, which checks that the rest of the result agrees.
- Not supported yet: formatting changes (bold, style changes on existing
  text), new footnotes or links, table row/column insertion, moves, typing
  inside another author's pending insertion (deleting inside one works, as
  Word does it), deleting a w:fldSimple field (its shell remains), and block
  ids carried across versions (1c).
- Inserted text takes the formatting of the text it replaces (Word's rule),
  so filling a highlighted placeholder keeps the highlight. Quotes are typed
  as the model sends them; the document's curly quotes are not imposed.

## Fixed along the way

- 1a: saving an edited package added directory entries Word never wrote;
  read_document's .docx parameters (section, from, to, full) were not in the
  tool schema; section reads compared outline levels with list levels and
  returned only the heading for clauses like "5.3".
- Station 2: get_diff selected a column document_edits does not have, so
  against a real database it always reported no pending edits.
