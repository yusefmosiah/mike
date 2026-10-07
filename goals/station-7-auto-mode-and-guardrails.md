---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T23:59:30Z"
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
    Eliminate approval fatigue for engineers and enable autonomous execution by implementing
    coding-agent Auto Mode with a multi-tiered permission engine and System 1 guardrail classifier.
  artifact: >-
    backend/src/lib/guardrails/ (Tier 1 allowlist, Tier 2 in-project workspace rules, Tier 3
    transcript classifier), Jev OpenRouter adapter for dev, local DGX model adapter for prod,
    deny-and-continue handler, and streaming integration in backend/src/modules/chat/engine/streaming.ts.
  acceptance:
    - action: npm test --prefix backend -- src/lib/guardrails/__tests__/autoMode.test.ts
      proves: Tier 1 tools execute without classifier latency; benign workspace mutations auto-approved; destructive or exfiltration calls blocked with in-band recovery.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/engine/__tests__/streamingAutoMode.test.ts
      proves: Streaming loop proceeds autonomously without pausing on ask_inputs when in Auto Mode.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/guardrails/ backend/src/modules/chat/engine/streaming.ts
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Maximize agent autonomy on benign and routine operations while intercepting destructive
    actions, indirect prompt injections, and scope escalations without human interruption.
  goodharting_would_be: >-
    Blanket --dangerously-skip-permissions flag that disables all safety checks, or a classifier
    that reads assistant persuasive rationalizations and is tricked into approving violations.

homotopy:
  realism_axis: >-
    From manual click-approval on every write action (low resolution) to
    three-tier permission hierarchy with reasoning-blind System 1 guardrail classifier and deny-and-continue (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Reasoning-blind design: classifier inspects only user intent and raw toolcall arguments (assistant prose stripped).
    - Deny-and-continue: blocked actions return in-band error allowing model recovery instead of turn crash.
    - Full autonomy for overnight RLM: RLM jobs must never pause on ask_inputs.
  excluded:
    - Modifying external connector OAuth scopes

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
    id: c-auto-mode-throughput
    claim: >-
      A two-stage System 1 classifier reduces user approval interruptions by >90% while
      catching unauthorized destructive mutations and prompt injections.
    test: Benchmark testset of 100 legal drafting toolcalls achieves <1% false positive blocks and zero unauthorized bulk deletions.
    edge: resource
    delta_o: Evaluation against curated agentic incident log.
    scope_if_supported: Agent execution pipeline.
    status: proposed
    evidence_refs: []
  decision:
    what: Use Jev via OpenRouter for dev; deploy fast quantized System 1 model on local DGX for private production.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 6.
    main_uncertainty: Classifier latency overhead on Tier 3 tool calls.
    next_observation: Benchmarking fast System 1 model token latency on DGX.
  blocker_or_risk: Blocked on completion of Station 6.
  next_action: Await Station 6 completion.

receipts: []
---

# Station 7: Auto Mode & System 1 Guardrails Engine

Implements coding-agent Auto Mode with multi-tier permissions, reasoning-blind classification, and autonomous execution.
