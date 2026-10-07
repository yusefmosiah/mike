---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-06
  frozen_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-06T21:25:00Z"
  source:
    canonical_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard e5d6bc8

finish:
  deliver: >-
    Replace naive flat-string regex substitution with an in-memory document tree
    and atomic block tools capable of deleting ranges, removing empty paragraphs,
    inserting multi-line blocks, and generating reversible Word tracked changes.
  artifact: >-
    backend/src/lib/docxAST.ts (OPC preservation and block indexing), updated
    backend/src/modules/chat/engine/tools/documentOps.ts with atomic block operations,
    and updated toolSchemas.ts.
  acceptance:
    - action: npm test --prefix backend -- src/lib/__tests__/docxAST.test.ts
      proves: Bounded block reads, range deletions (60 entries), multiline inserts, and empty paragraph cleanup.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/__tests__/integration/chat.routes.test.ts
      proves: Chat assistant successfully calls block tools and persists atomic tracked changes.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/docxAST.ts backend/src/modules/chat/engine/tools/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Eliminate ambiguous substitution failures and unexpressible structural operations
    while preserving 100% of untouched OpenXML parts and formatting.
  goodharting_would_be: >-
    Rewriting the entire document from a lossy text AST that discards mixed run styles,
    drawing objects, and section breaks.

homotopy:
  realism_axis: >-
    From single-paragraph string regex (low resolution) to preservation-first
    OPC AST with paragraph-mark revisions and reversible relationship tables (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
    - docs/private-deployment-scoping.md
  must_preserve:
    - Relationship entries and footnote definitions of pending deletions must never be pruned.
    - Untouched XML nodes and package parts must remain bit-for-bit identical.
    - All-or-nothing batch atomicity: if one edit fails, no version is activated.
  excluded:
    - Rewriting the frontend document viewer
    - Modifying client-side OfficeJS add-in logic

now:
  status: needs_rework
  slice: docx-ast-core-parser
  source_ref: 3a37928b98b95da8a0d922bbcf16b9cb8523c91a
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-ast-landed
    state: landed
    ref: main
    base: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
    digest: none
    scope: [backend/src/lib/docxAST.ts, backend/src/modules/chat/engine/tools/documentOps.ts]
  conjecture:
    id: c-preservation-ast-fidelity
    claim: >-
      Retaining the OPC package DOM while assigning stable IDs to body elements allows
      atomic structural operations without corrupting arbitrary Word formatting.
    test: Round-trip parse and serialize on real 13-page document reproduces exact XML when unmutated.
    edge: missing_oracle
    delta_o: Canonicalized XML diff test against original fixture.
    scope_if_supported: Document editing engine.
    status: active
    evidence_refs: [backend/src/lib/__tests__/docxAST.test.ts, backend/src/modules/chat/engine/tools/__tests__/documentOps.blocks.test.ts]
  decision:
    what: Use fast-xml-parser preserve-order mode in docxAST.ts, extending docxTrackedChanges.ts patterns.
    kind: architecture
    status: settled
    evidence_ref: consensus-review-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: In-memory AST and atomic block tools operational and verified on main.
    main_uncertainty: none
    next_observation: Station 2 self-verification loop and get_diff tool.
  blocker_or_risk: none
  next_action: none

receipts:
  - id: station-1-code-landed
    boundary: terminal
    identity: 3a37928
    proof_refs:
      - backend/src/lib/__tests__/docxAST.test.ts
      - backend/src/modules/chat/engine/tools/__tests__/documentOps.blocks.test.ts
    rollback_ref: 9da0200
    disposition: Station 1 landed on main with passing 38-test suite.
---

> **Status (2026-10-07): needs_rework.** This file was written by the overnight run and
> overstates what landed. See [`goals/STATUS.md`](STATUS.md) for the audited state.

# Station 1: In-Memory Document AST & Block Tools

This station replaces fragile text substitution in `documentOps.ts` with an in-memory block AST.

## Core Capabilities
- `read_blocks`: Bounded reading by stable paragraph/table/footnote IDs.
- `delete_blocks`: Multi-paragraph and table range deletion.
- `delete_empty_blocks`: Cleanup of empty paragraphs without disturbing section breaks.
- `insert_block`: Multi-line insertion preserving paragraph structure.
- `replace_block`: Fail-closed replacement rejecting ambiguous matches.
