---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T23:59:50Z"
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
    Deploy a secure JS/TS execution sandbox for financial/tabular modeling and an autonomous
    TypeScript Recursive Language Model (RLM) engine running 24/7 in full Auto Mode for
    massive data room diligence, speculative redlining, and firm memory dreaming.
  artifact: >-
    backend/src/jobs/registry.ts (rlm.deep_run background job), packages/mike-sdk (TypeScript
    domain SDK), isolated Bun/Node worker container, and root orchestrator REPL harness.
  acceptance:
    - action: npm test --prefix backend -- src/jobs/__tests__/rlmDeepRun.test.ts
      proves: RLM orchestrator loads multi-document corpus into REPL, dispatches parallel subagents, and synthesizes cited diligence memo without context exhaustion.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/engine/tools/__tests__/executeCode.test.ts
      proves: Sandboxed JS/TS code executes with zero network egress and strict resource caps.
      evidence_class: local_test
  rollback: git checkout -- backend/src/jobs/ packages/mike-sdk backend/src/modules/chat/engine/tools/executeCode.ts
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Unlock deep overnight diligence across 5,000-document data rooms (up to 80M tokens) on owned
    DGX compute without context saturation or manual step ceilings.
  goodharting_would_be: >-
    Stuffing entire large data rooms into one monolithic context window causing "lost-in-the-middle"
    omissions and shallow diligence coverage.

homotopy:
  realism_axis: >-
    From single-turn chat tool loops with 16-step ceilings (low resolution) to
    autonomous asynchronous REPL orchestrator dispatching parallel subagent trees over owned compute (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Read-only copy-on-write access to original matter document vaults during overnight diligence.
    - Zero network egress from code execution and RLM worker sandbox containers.
    - Full Auto Mode: RLM jobs must never pause for interactive human approval.
  excluded:
    - Running untrusted foreign binary executables

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
    id: c-rlm-coverage-scaling
    claim: >-
      A TypeScript REPL harness dispatching bounded subagents across matter folders achieves >90%
      data room coverage compared to <1% for monolithic chat loops.
    test: LAB Diligence benchmark data room evaluation confirms >90% probe coverage.
    edge: resource
    delta_o: Evaluation run on simulated corporate diligence data room.
    scope_if_supported: Autonomous legal diligence engine.
    status: proposed
    evidence_refs: []
  decision:
    what: Build RLM harness in TypeScript/Bun to directly import Mike's compiled domain modules.
    kind: architecture
    status: settled
    evidence_ref: docs/private-deployment-scoping.md
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 8.
    main_uncertainty: Subagent coordination latency and reconciliation of non-conflicting findings.
    next_observation: Testing parallel subagent wave dispatch on local DGX endpoints.
  blocker_or_risk: Blocked on completion of Station 8.
  next_action: Await Station 8 completion.

receipts: []
---

# Station 9: Sandboxed Code Execution & 24/7 TypeScript RLM Diligence

Enables the "Night Shift": autonomous overnight M&A due diligence, speculative redline generation, and firm memory consolidation on owned compute.
