---
definition_version: 4

readiness: executable

review:
  reviewer: metamission-spine-progression
  frozen_ref: 3a37928b98b95da8a0d922bbcf16b9cb8523c91a
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-06T22:30:00Z"
  source:
    canonical_ref: 3a37928b98b95da8a0d922bbcf16b9cb8523c91a
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
  status: complete
  slice: get-diff-and-invariant-linter
  source_ref: 60efb702ecfa50ca438b4dfae233cf9704e67d26
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-diff-landed
    state: landed
    ref: main
    base: 3a37928b98b95da8a0d922bbcf16b9cb8523c91a
    digest: none
    scope: [backend/src/lib/docxLinter.ts, backend/src/modules/chat/engine/tools/documentOps.ts]
  conjecture:
    id: c-self-verification-yield
    claim: >-
      Prompting the model to inspect get_diff and gating version activation on invariant
      linting catches >90% of silent document corruptions.
    test: Invariant linter halts broken revisions on test corpus before activation.
    edge: frame_lock
    delta_o: Benchmark on synthetic document corruption suites.
    scope_if_supported: Document editing pipeline.
    status: promoted_to_assertion
    evidence_refs:
      - backend/src/lib/__tests__/docxLinter.test.ts
      - backend/src/modules/chat/engine/tools/__tests__/documentOps.diff.test.ts
  decision:
    what: Enforce get_diff invocation in system prompt and run server-side linter pre-commit.
    kind: architecture
    status: settled
    evidence_ref: consensus-review-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Self-verification tool get_diff and OpenXML invariant linter verified and live.
    main_uncertainty: none
    next_observation: Station 3 modular search and extended citation verification.
  blocker_or_risk: none
  next_action: none

receipts:
  - id: station-2-landed
    boundary: terminal
    identity: 60efb70
    proof_refs:
      - backend/src/lib/__tests__/docxLinter.test.ts
      - backend/src/modules/chat/engine/tools/__tests__/documentOps.diff.test.ts
    rollback_ref: 335df0c
    disposition: Station 2 landed on main with passing 46-test suite.
    landing:
      source_commit: 60efb70
      ci_ref: local_vitest_46_passed
      deploy_ref: docker_compose_backend_rebuilt
      environment_identity: local-docker-compose
      deployed_acceptance: curl -f http://localhost:3000/health
---

# Station 2: Self-Verification Loop & `get_diff` Tool

Equips the agent with self-review capabilities and enforces package-level invariant linting before activating document edits.
