---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: a756ea2
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T02:15:00Z"
  source:
    canonical_ref: a756ea2
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard a756ea2

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
  status: unverified
  slice: pi-tree-branching
  source_ref: a756ea2
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-branching-done
    state: ready
    ref: main
    base: e8a9b1c
    digest: none
    scope: [backend/src/modules/chat/, backend/src/modules/project-chat/, frontend/src/app/components/assistant/]
  conjecture:
    id: c-tree-branching-context-integrity
    claim: >-
      Walking server-authoritative leaf-to-root paths guarantees that abandoned branches
      never leak into the LLM context window.
    test: Test suite verifies context tokens contain only the active branch's ancestry.
    edge: independence
    delta_o: Context inspection unit tests in chat.tree.test.ts.
    scope_if_supported: Conversation engine.
    status: supported
    evidence_refs: [a756ea2]
  decision:
    what: Implemented parent_message_id hierarchy with per-user leaf tracking table.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-07
    owner_ratification_ref: user-prompt-2026-10-07
  belief:
    believed_state: Station 5 landed at a756ea2; edit-prompt, regenerate, branch-into-new-thread, and sibling navigation live on both chat surfaces.
    main_uncertainty: Sibling navigation on user messages shows the prompt without auto-hopping to its newest answer child.
    next_observation: Station 6 local audio proxies.
  blocker_or_risk: none
  next_action: Advance spine to Station 6.

receipts:
  - id: station-5-code-landed
    boundary: implement
    identity: a756ea2
    proof_refs:
      - backend/src/__tests__/integration/chat.tree.test.ts
      - frontend/src/app/components/assistant/ChatView.branch.test.tsx
      - frontend/src/app/components/assistant/useChatBranchActions.test.tsx
    rollback_ref: e8a9b1c
    disposition: Station 5 landed on main; backend 2848 pass (2 pre-existing openrouter failures), assistant suite 245/245, pages 44/44, hooks+lib 729/729.
---

> **Status (2026-10-07): unverified.** This file was written by the overnight run and
> overstates what landed. See [`goals/STATUS.md`](STATUS.md) for the audited state.

# Station 5: Pi-Style Conversation Tree & Branching UI

Introduces Pi-style branching conversation histories, parent_message_id relationships, and UI branch navigation.
