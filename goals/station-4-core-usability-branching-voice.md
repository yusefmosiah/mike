---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T21:40:00Z"
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
    Upgrade conversation architecture to a Pi-style immutable tree with edit-and-branch
    and regeneration, and provide local private audio transcription (STT) and read-aloud (TTS).
  artifact: >-
    Database migration for parent_message_id and chat_leaf_state, server-authoritative
    context builder in backend/src/modules/chat/chat.prepare.ts, frontend branching controls
    in UserMessage.tsx and AssistantMessage.tsx, and backend/src/modules/audio/ endpoints.
  acceptance:
    - action: npm test --prefix backend -- src/__tests__/integration/chat.tree.test.ts
      proves: Tree context builder traverses leaf to root; alternate branches remain intact without leaking into model context.
      evidence_class: local_test
    - action: curl -f -X POST http://localhost:3000/audio/transcriptions -F "file=@test.wav"
      proves: Audio proxy transcribes speech locally without external cloud telemetry.
      evidence_class: deployed_proof
  rollback: git checkout -- backend/src/modules/chat/ backend/src/modules/audio/ frontend/src/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Enable non-destructive prompt revision and private voice dictation while keeping
    all conversation branches immutable and uncorrupted.
  goodharting_would_be: >-
    Destructive SQL UPDATE of prior user prompts that destroys earlier drafting history,
    or routing audio through public cloud browser speech APIs.

homotopy:
  realism_axis: >-
    From linear flat transcripts and typed-only inputs (low resolution) to
    immutable directed acyclic message trees and local private voice proxies (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Existing flat chat messages must backfill cleanly with parent links.
    - Zero audio retention on disk (ephemeral stream processing).
  excluded:
    - Complex multi-speaker voice transcription diarization

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
    evidence_ref: private-ai-briefing
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 3.
    main_uncertainty: Backfill migration performance on existing long transcripts.
    next_observation: Testing migration on local Supabase container.
  blocker_or_risk: Blocked on completion of Station 3.
  next_action: Await Station 3 completion.

receipts: []
---

# Station 4: Core Usability: Pi-Tree Branching & Local Audio

Introduces Pi-style branching conversation histories and private STT/TTS audio endpoints.
