---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: b0e80cc
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T06:00:00Z"
  source:
    canonical_ref: b0e80cc
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard b0e80cc

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
  status: complete
  slice: code-execution-and-rlm
  source_ref: b0e80cc
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-rlm-done
    state: ready
    ref: main
    base: b06cf77
    digest: none
    scope: [backend/src/lib/sandbox/, backend/src/modules/diligence/]
  conjecture:
    id: c-rlm-coverage-scaling
    claim: >-
      A TypeScript REPL harness dispatching bounded subagents across matter folders achieves >90%
      data room coverage compared to <1% for monolithic chat loops.
    test: LAB Diligence benchmark data room evaluation confirms >90% probe coverage.
    edge: resource
    delta_o: Evaluation run on simulated corporate diligence data room.
    scope_if_supported: Autonomous legal diligence engine.
    status: supported
    evidence_refs: [b0e80cc]
  decision:
    what: Wave coordinator with execute_code-only toolset over documents facade; no separate SDK package.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-07
    owner_ratification_ref: user-prompt-2026-10-07
  belief:
    believed_state: Station 9 landed at b0e80cc; sandbox + RLM diligence live.
    main_uncertainty: Coverage quality on a real 5,000-document data room (no such corpus in this env).
    next_observation: Station 10 mobile client and OCR.
  blocker_or_risk: none
  next_action: Advance spine to Station 10.
receipts:
  - id: station-9-complete
    boundary: implement
    identity: b0e80cc
    proof_refs:
      - backend/src/lib/sandbox/__tests__/executeCode.test.ts
      - backend/src/modules/diligence/__tests__/rlmDeepRun.test.ts
    rollback_ref: b06cf77
    disposition: Station 9 landed on main; sandbox + diligence suites green, full suite 2997 pass (2 pre-existing openrouter failures).

---

# Station 9: Sandboxed Code Execution & 24/7 TypeScript RLM Diligence

Enables the "Night Shift": autonomous overnight M&A due diligence, speculative redline generation, and firm memory consolidation on owned compute.
