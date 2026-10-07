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
      status: working
      depends_on: []
    - id: station-2-self-verification-and-diff
      path: goals/station-2-self-verification-and-diff.md
      readiness: drafted
      status: pending
      depends_on: [station-1-doc-ast-and-block-tools]
    - id: station-3-modular-search-and-citations
      path: goals/station-3-modular-search-and-citations.md
      readiness: drafted
      status: pending
      depends_on: [station-2-self-verification-and-diff]
    - id: station-4-core-usability-branching-voice
      path: goals/station-4-core-usability-branching-voice.md
      readiness: drafted
      status: pending
      depends_on: [station-3-modular-search-and-citations]
    - id: station-5-auto-mode-and-guardrails
      path: goals/station-5-auto-mode-and-guardrails.md
      readiness: drafted
      status: pending
      depends_on: [station-4-core-usability-branching-voice]
    - id: station-6-private-hardening-and-phala
      path: goals/station-6-private-hardening-and-phala.md
      readiness: drafted
      status: pending
      depends_on: [station-5-auto-mode-and-guardrails]
    - id: station-7-code-execution-and-rlm
      path: goals/station-7-code-execution-and-rlm.md
      readiness: drafted
      status: pending
      depends_on: [station-6-private-hardening-and-phala]
    - id: station-8-mobile-client-and-ocr
      path: goals/station-8-mobile-client-and-ocr.md
      readiness: drafted
      status: pending
      depends_on: [station-7-code-execution-and-rlm]

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

now:
  status: working
  slice: station-1-doc-ast-and-block-tools
  source_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
  deploy_identity: local-docker-compose
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
  next_action: Author goals/station-1-doc-ast-and-block-tools.md and initialize companion ledger.

receipts:
  - id: spine-init
    boundary: define
    identity: e5d6bc8
    proof_refs: [docs/private-deployment-scoping.md]
    rollback_ref: aaaa32d
    disposition: Metamission spine initialized with 8 stations and approved phase sequence.
---

# Metamission: Private Firm Deployment Spine

This goal file serves as the executive spine authority for transitioning the Mike OSS repository into a production-grade, firm-owned private legal intelligence system.

## Station Sequence
1. **Station 1**: In-Memory Document AST & Atomic Block Tools (`goals/station-1-doc-ast-and-block-tools.md`)
2. **Station 2**: Self-Verification Loop & `get_diff` Tool (`goals/station-2-self-verification-and-diff.md`)
3. **Station 3**: Modular Search & Extended Citation Verification (`goals/station-3-modular-search-and-citations.md`)
4. **Station 4**: Core Usability: Pi-Tree Branching & Local Audio (`goals/station-4-core-usability-branching-voice.md`)
5. **Station 5**: Auto Mode & System 1 Guardrails Engine (`goals/station-5-auto-mode-and-guardrails.md`)
6. **Station 6**: Private Deployment Hardening & Phala TEE Lane (`goals/station-6-private-hardening-and-phala.md`)
7. **Station 7**: Sandboxed Code Execution & 24/7 TypeScript RLM Diligence (`goals/station-7-code-execution-and-rlm.md`)
8. **Station 8**: Native Mobile Client & Deep Ingestion OCR (`goals/station-8-mobile-client-and-ocr.md`)
