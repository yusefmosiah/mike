---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T21:30:00Z"
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
    Remove the human as the sole verifier by giving the assistant a model-friendly
    get_diff tool and server-side invariant checks before document version activation.
  artifact: >-
    get_diff tool in backend/src/modules/chat/engine/tools/toolSchemas.ts and
    documentOps.ts, invariant linter in backend/src/lib/docxLinter.ts, and prompt
    self-review loop in prompts.ts.
  acceptance:
    - action: npm test --prefix backend -- src/lib/__tests__/docxLinter.test.ts
      proves: Detection of dangling references, unreferenced relationships, and separator footnote exemptions.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/__tests__/integration/chat.diff.test.ts
      proves: Assistant invokes get_diff, reviews output, and commits validated diff.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/docxLinter.ts backend/src/modules/chat/engine/tools/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Detect self-induced formatting, citation, or numbering defects inside the agent loop
    before the user ever opens the Word document.
  goodharting_would_be: >-
    A purely cosmetic diff tool that the agent ignores or that passes without checking
    compiled OpenXML package validity.

homotopy:
  realism_axis: >-
    From zero agent feedback on mutations (low resolution) to model-friendly AST diff
    and compiled package invariant linting (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Separator footnotes (-1 and 0) must be exempt from orphan checks.
    - get_diff must reflect current working revision; any subsequent mutation invalidates prior review.
  excluded:
    - Natural language proofreading checks inside the structural linter

now:
  status: pending
  slice: none
  source_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
  deploy_identity: local-docker-compose
  candidate:
    id: none
    state: none
    ref: none
    base: none
    digest: none
    scope: []
  conjecture:
    id: c-self-verification-yield
    claim: >-
      Prompting the model to inspect get_diff and gating version activation on invariant
      linting catches >90% of silent document corruptions.
    test: Invariant linter halts broken revisions on test corpus before activation.
    edge: frame_lock
    delta_o: Benchmark on synthetic document corruption suites.
    scope_if_supported: Document editing pipeline.
    status: proposed
    evidence_refs: []
  decision:
    what: Enforce get_diff invocation in system prompt and run server-side linter pre-commit.
    kind: architecture
    status: settled
    evidence_ref: consensus-review-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 1 in-memory AST and diff generator.
    main_uncertainty: Token consumption of diffs on large (50+ page) agreements.
    next_observation: Benchmarking get_diff representation on 13-page contract.
  blocker_or_risk: Blocked on completion of Station 1.
  next_action: Await Station 1 completion.

receipts: []
---

# Station 2: Self-Verification Loop & `get_diff` Tool

Equips the agent with self-review capabilities and enforces package-level invariant linting before activating document edits.
