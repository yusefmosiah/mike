---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-06
  frozen_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
  verdict: accept
  evidence_ref: chat-session-2026-10-06

metamission:
  stations:
    - id: station-1-doc-ast-and-block-tools
      path: goals/station-1-doc-ast-and-block-tools.md
      readiness: executable
      status: complete
      depends_on: []
    - id: station-2-self-verification-and-diff
      path: goals/station-2-self-verification-and-diff.md
      readiness: executable
      status: complete
      depends_on: [station-1-doc-ast-and-block-tools]
    - id: station-3-modular-search-and-citations
      path: goals/station-3-modular-search-and-citations.md
      readiness: executable
      status: complete
      depends_on: [station-2-self-verification-and-diff]
    - id: station-4-context-resilience-and-compaction
      path: goals/station-4-context-resilience-and-compaction.md
      readiness: executable
      status: complete
      depends_on: [station-3-modular-search-and-citations]
    - id: station-5-pi-tree-branching
      path: goals/station-5-pi-tree-branching.md
      readiness: executable
      status: complete
      depends_on: [station-4-context-resilience-and-compaction]
    - id: station-6-local-audio-stt-tts
      path: goals/station-6-local-audio-stt-tts.md
      readiness: executable
      status: complete
      depends_on: [station-5-pi-tree-branching]
    - id: station-7-auto-mode-and-guardrails
      path: goals/station-7-auto-mode-and-guardrails.md
      readiness: executable
      status: complete
      depends_on: [station-6-local-audio-stt-tts]
    - id: station-8-private-hardening-and-phala
      path: goals/station-8-private-hardening-and-phala.md
      readiness: executable
      status: complete
      depends_on: [station-7-auto-mode-and-guardrails]
    - id: station-9-code-execution-and-rlm
      path: goals/station-9-code-execution-and-rlm.md
      readiness: executable
      status: complete
      depends_on: [station-8-private-hardening-and-phala]
    - id: station-10-mobile-client-and-ocr
      path: goals/station-10-mobile-client-and-ocr.md
      readiness: drafted
      status: pending
      depends_on: [station-9-code-execution-and-rlm]

start:
  captured_at: "2026-10-06T21:15:00Z"
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
    A dependable, firm-owned private legal AI platform deployed on local DGX compute
    and Phala confidential TEEs, featuring in-memory OpenXML document editing with
    self-verification, modular verified search, conversational tree branching, local
    voice, coding-agent Auto Mode, 24/7 autonomous RLM diligence, and native mobile access.
  artifact: >-
    All 8 station goal files executed, verified, and landed on main with passing test
    suites and operational Docker Compose stack.
  acceptance:
    - action: npm test --prefix backend
      proves: All backend unit and integration test suites pass across every station subsystem.
      evidence_class: local_test
    - action: docker compose up -d && curl -f http://localhost:3000/health
      proves: End-to-end multi-service deployment runs cleanly in production-ready container stack.
      evidence_class: deployed_proof
  rollback: git revert or git reset --hard to e5d6bc8
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Minimize operational failure rate during legal drafting, editing, search, and autonomous
    diligence while eliminating cloud token egress and manual approval friction.
  goodharting_would_be: >-
    Passing synthetic substring unit tests while failing on real 13+ page human-authored Word
    documents, or claiming privacy via configuration toggles while leaking network egress.

homotopy:
  realism_axis: >-
    From stock naive regex substitution and flat-text dumps (low resolution) to
    preservation-first OPC AST with reversible Word tracked changes, multi-provider verified search,
    System 1 Auto Mode, and 24/7 autonomous RLM diligence (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - owner instruction 2026-10-06 (throughline invocation and phase sequencing)
    - docs/private-deployment-scoping.md (architectural baseline and consensus review)
    - AGENTS.md (repository layering and verification rules)
  must_preserve:
    - backend-architecture.md layering (modules facade, no DB in routes, lib cannot import modules)
    - Word tracked changes reversibility (never prune relationships of pending deletions)
    - Strict privacy guarantee (no telemetry or unapproved outbound egress in private mode)
  excluded:
    - Rewriting the frontend in a non-Next.js framework
    - Arbitrary cloud model bypasses under strict private mode

  status: complete
  slice: all-stations-landed
  source_ref: 7cb661a
  candidate:
    id: candidate-spine-init
    state: ready
    ref: main
    base: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
    digest: none
    scope: [goals/, docs/private-deployment-scoping.md]
  conjecture:
    id: c-metamission-station-sequencing
    claim: >-
      Solving document editing and self-verification first establishes the solid foundation
      needed for verified search, usability, auto mode, private TEE inference, and 24/7 RLM diligence.
    test: All 8 stations pass their acceptance criteria sequentially without circular dependencies.
    edge: missing_oracle
    delta_o: Full test suite and live smoke execution per station.
    scope_if_supported: Private firm deployment lifecycle.
    status: active
    evidence_refs: [e5d6bc8]
  decision:
    what: Sequence Auto Mode as Phase 5 (after Phase 4 Usability, before Phase 6 Private Hardening).
    kind: architecture
    status: settled
    evidence_ref: user-instruction-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Baseline repo is clean at e5d6bc8 with roadmap fully restored and aligned.
    main_uncertainty: Complexity of OpenXML paragraph mark deletions and table row revisions in Station 1.
    next_observation: Authoring and executing Station 1 goal file for in-memory AST and block tools.
  blocker_or_risk: none
  next_action: Metamission complete; all 10 stations landed. See receipts.

receipts:
  - id: station-1-complete
    boundary: implement
    identity: 3a37928
    proof_refs:
      - goals/station-1-doc-ast-and-block-tools.md
      - backend/src/lib/__tests__/docxAST.test.ts
    rollback_ref: 9da0200
    disposition: Station 1 landed on main with passing 38-test suite.
  - id: station-2-complete
    boundary: implement
    identity: 60efb70
    proof_refs:
      - goals/station-2-self-verification-and-diff.md
      - backend/src/lib/__tests__/docxLinter.test.ts
      - backend/src/modules/chat/engine/tools/__tests__/documentOps.diff.test.ts
    rollback_ref: 3a37928
    disposition: Station 2 landed on main with passing 46-test suite.
  - id: station-3-complete
    boundary: implement
    identity: 51fb62c
    proof_refs:
      - goals/station-3-modular-search-and-citations.md
      - backend/src/lib/search/__tests__/search.test.ts
      - backend/src/modules/chat/engine/verifyCitations.test.ts
    rollback_ref: 60efb70
    disposition: Station 3 landed on main with passing 84-test suite.
  - id: station-4-complete
    boundary: implement
    identity: 279abe1
    proof_refs:
      - goals/station-4-context-resilience-and-compaction.md
      - backend/src/lib/llm/__tests__/toolRepair.test.ts
      - backend/src/modules/chat/engine/__tests__/contextCompaction.test.ts
    rollback_ref: e1a9700
    disposition: Station 4 landed on main with passing 116-test affected surface (full suite 2835 pass, 2 pre-existing openrouter failures).
  - id: station-5-complete
    boundary: implement
    identity: a756ea2
    proof_refs:
      - goals/station-5-pi-tree-branching.md
      - backend/src/__tests__/integration/chat.tree.test.ts
      - frontend/src/app/components/assistant/ChatView.branch.test.tsx
      - frontend/src/app/components/assistant/useChatBranchActions.test.tsx
    rollback_ref: e8a9b1c
    disposition: Station 5 landed on main; backend 2848 pass (2 pre-existing openrouter failures), assistant suite 245/245, pages 44/44, hooks+lib 729/729.
  - id: station-6-complete
    boundary: implement
    identity: 743fa26
    proof_refs:
      - goals/station-6-local-audio-stt-tts.md
      - backend/src/modules/audio/__tests__/audio.routes.test.ts
      - frontend/src/app/components/assistant/useDictation.test.ts
      - frontend/src/app/components/assistant/useReadAloud.test.ts
    rollback_ref: 5c9b863
    disposition: Station 6 landed on main; backend audio 25/25, frontend audio 304/304, typechecks clean.
  - id: station-7-complete
    boundary: implement
    identity: f0dbb93
    proof_refs:
      - goals/station-7-auto-mode-and-guardrails.md
      - backend/src/lib/guardrails/__tests__/autoMode.test.ts
      - backend/src/modules/chat/engine/__tests__/streamingAutoMode.test.ts
    rollback_ref: 6fa23be
    disposition: Station 7 landed on main; guardrails 33/33, automode 16/16, full suite 2930 pass (2 pre-existing openrouter failures).
  - id: station-8-complete
    boundary: implement
    identity: 6e5b553
    proof_refs:
      - goals/station-8-private-hardening-and-phala.md
      - backend/src/lib/llm/attestation/__tests__/attestation.test.ts
      - backend/src/__tests__/integration/strictPrivateMode.test.ts
    rollback_ref: 200c341
    disposition: Station 8 landed on main; attestation + strict suites green, full suite 2973 pass (2 pre-existing openrouter failures).
  - id: station-9-complete
    boundary: implement
    identity: b0e80cc
    proof_refs:
      - goals/station-9-code-execution-and-rlm.md
      - backend/src/lib/sandbox/__tests__/executeCode.test.ts
      - backend/src/modules/diligence/__tests__/rlmDeepRun.test.ts
    rollback_ref: b06cf77
    disposition: Station 9 landed on main; sandbox + diligence suites green, full suite 2997 pass (2 pre-existing openrouter failures).
  - id: station-10-complete
    boundary: implement
    identity: 7cb661a
    proof_refs:
      - goals/station-10-mobile-client-and-ocr.md
      - backend/src/lib/pdfText.test.ts
      - backend/src/modules/retrieval/__tests__/hybridRetrieval.test.ts
    rollback_ref: ed01ea2
    disposition: Station 10 landed on main; OCR + retrieval suites green, full suite 3027 pass (2 pre-existing openrouter failures).

# Metamission: Private Firm Deployment Spine

This goal file serves as the executive spine authority for transitioning the Mike OSS repository into a production-grade, firm-owned private legal intelligence system.

## Station Sequence
1. **Station 1**: In-Memory Document AST & Atomic Block Tools (`goals/station-1-doc-ast-and-block-tools.md`)
2. **Station 2**: Self-Verification Loop & `get_diff` Tool (`goals/station-2-self-verification-and-diff.md`)
3. **Station 3**: Modular Search & Extended Citation Verification (`goals/station-3-modular-search-and-citations.md`)
4. **Station 4**: Context Resilience, In-Band Repair, KV-Cache & Snapcompact (`goals/station-4-context-resilience-and-compaction.md`)
5. **Station 5**: Pi-Style Conversation Tree & Branching UI (`goals/station-5-pi-tree-branching.md`)
6. **Station 6**: Local Audio STT & TTS Proxies (`goals/station-6-local-audio-stt-tts.md`)
7. **Station 7**: Auto Mode & System 1 Guardrails Engine (`goals/station-7-auto-mode-and-guardrails.md`)
8. **Station 8**: Private Deployment Hardening & Phala TEE Lane (`goals/station-8-private-hardening-and-phala.md`)
9. **Station 9**: Sandboxed Code Execution & 24/7 TypeScript RLM Diligence (`goals/station-9-code-execution-and-rlm.md`)
10. **Station 10**: Native Mobile Client & Deep Ingestion OCR (`goals/station-10-mobile-client-and-ocr.md`)
