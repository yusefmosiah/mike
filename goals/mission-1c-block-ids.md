---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: ff47074
  verdict: accept
  evidence_ref: goals/STATUS.md

finish:
  deliver: >-
    Block ids that keep naming the same paragraph across versions of a
    document: after edits, after accept/reject, and after a new upload of a
    file edited elsewhere. An id the model read earlier stays valid.
  artifact: >-
    backend/src/lib/docx/blockIds.ts (alignment and carrying),
    DocxDocument.relabel, document_versions.block_ids (migration
    20261007_04), backend/src/modules/documents/documents.blockIds.ts, and
    the read, find, edit and accept/reject paths using them.
  acceptance:
    - action: npm test --prefix backend -- src/lib/docx/__tests__/blockIds.test.ts
      proves: >-
        An unchanged document keeps its own ids; in a document without Word
        paragraph ids, an insert, a delete and then accept-all leave every
        surviving paragraph with its original id and the inserted one with
        "p19+1"; a deleted block's id is never reused; ids carry across a
        re-saved file with no tracked changes; the 12,600-paragraph
        schedules align in under 3 seconds.
      evidence_class: local_test
    - action: cd backend && npx tsx scripts/probe-docx-editing.ts (part 2)
      proves: >-
        Through the real dispatcher and database: after an inserted
        paragraph is accepted, read_document from "p20" returns the same
        paragraph as before, and the accepted paragraph keeps "p19+1".
      evidence_class: local_probe

value:
  better_means: >-
    A model (or a user quoting a block id) can come back to a document after
    the user accepted or rejected changes, or uploaded a new copy from Word,
    and the ids it has still point at the same clauses.
  goodharting_would_be: >-
    Ids that only survive when nothing changed; reusing a deleted block's id
    for another block.

boundaries:
  must_preserve:
    - The bytes of the document: ids live in the database, not in the file.
    - Default ids for a document's first version (Word paraIds, otherwise ordinals).
  excluded:
    - Ids for headers, footers and text boxes.

now:
  status: awaiting_owner_review
  slice: complete-pending-review
  blocker_or_risk: >-
    Alignment of heavily rewritten files (a re-upload where most paragraphs
    changed) pairs edited blocks by position and word overlap; a paragraph
    rewritten beyond recognition gets a new id.
  next_action: Owner review.

receipts:
  - action: npm test --prefix backend -- src/lib/docx/__tests__/blockIds.test.ts
    result: "6 passed (6)."
  - action: cd backend && npx tsx scripts/probe-docx-editing.ts
    result: "PROBE PASSED: 26/26 checks, including part 2 (p20 and p19+1 stable after accept)."
---

# Mission 1c: Block IDs Across Versions

Part of Mission 1 in [`goals/STATUS.md`](STATUS.md), after
[1a](mission-1a-docx-ast-and-reading.md) and [1b](mission-1b-docx-editing.md).

## Design

- **Default ids** stay as 1a defined them: Word's `w14:paraId` when present
  and unique, otherwise ordinals; inserted paragraphs are named after the
  paragraph before them (`p12+1`).
- **Stored ids:** each version row keeps `block_ids = {sha256, ids}`: the ids
  of its id-bearing blocks (body and cell paragraphs and tables, in document
  order) and the hash of the bytes they describe. A hash that no longer
  matches means the bytes changed by some other path; the ids are then
  re-derived on the next read.
- **Carrying:** a new version's blocks are aligned with the previous
  version's: common prefix and suffix, anchors on blocks unique to both
  sides (kept in order by a longest increasing subsequence), exact LCS for
  small leftovers, then gaps paired by position and word overlap. Paired
  blocks keep their ids; new blocks are named after the block before them;
  an id the previous version had is never given to a different block.
- **Where:** the edit tool passes the version's ids to the engine and stores
  the carried ids on the version it creates or overwrites; accept/reject
  stores them with the new bytes; read and find label the view with them,
  deriving them from the previous version when missing (uploads, Word
  saves, versions made before this change).
