---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T23:58:00Z"
  source:
    canonical_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard 51fb62c

finish:
  deliver: >-
    Upgrade conversation architecture to a Pi-style immutable tree with edit-and-branch,
    regeneration, and sibling branch navigation controls.
  artifact: >-
    Database migration for parent_message_id and chat_leaf_state, server-authoritative
    context builder in backend/src/modules/chat/chat.prepare.ts, and frontend branching
    controls in UserMessage.tsx and AssistantMessage.tsx.
  acceptance:
    - action: npm test --prefix backend -- src/__tests__/integration/chat.tree.test.ts
      proves: Tree context builder traverses leaf to root; alternate branches remain intact without leaking into model context.
      evidence_class: local_test
  rollback: git checkout -- backend/src/modules/chat/ frontend/src/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Enable non-destructive prompt revision and alternate exploration paths while keeping
    all conversation branches immutable and uncorrupted.
  goodharting_would_be: >-
    Destructive SQL UPDATE of prior user prompts that destroys earlier drafting history.

homotopy:
  realism_axis: >-
    From linear flat transcripts (low resolution) to
    immutable directed acyclic message trees with per-user leaf state (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Existing flat chat messages must backfill cleanly with parent links.
  excluded:
    - Cross-conversation branch merging

now:
  status: pending
  slice: none
  source_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
  deploy_identity: local-docker-compose
  candidate:
    id: none
    state: none
    ref: none
    base: none
    digest: none
    scope: []
  conjecture:
    id: c-tree-branching-context-integrity
    claim: >-
      Walking server-authoritative leaf-to-root paths guarantees that abandoned branches
      never leak into the LLM context window.
    test: Test suite verifies context tokens contain only the active branch's ancestry.
    edge: independence
    delta_o: Context inspection unit tests in chat.prepare.test.ts.
    scope_if_supported: Conversation engine.
    status: proposed
    evidence_refs: []
  decision:
    what: Implement parent_message_id hierarchy with per-user leaf tracking table.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 4.
    main_uncertainty: Backfill migration performance on existing long transcripts.
    next_observation: Testing migration on local Supabase container.
  blocker_or_risk: Blocked on completion of Station 4.
  next_action: Await Station 4 completion.

receipts: []
---

# Station 5: Pi-Style Conversation Tree & Branching UI

Introduces Pi-style branching conversation histories, parent_message_id relationships, and UI branch navigation.
