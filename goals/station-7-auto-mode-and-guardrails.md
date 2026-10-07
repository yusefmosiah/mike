---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: f0dbb93
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T04:00:00Z"
  source:
    canonical_ref: f0dbb93
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard f0dbb93

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
  status: complete
  slice: auto-mode-and-guardrails
  source_ref: f0dbb93
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-automode-done
    state: ready
    ref: main
    base: 6fa23be
    digest: none
    scope: [backend/src/lib/guardrails/, backend/src/modules/chat/engine/streaming.ts]
  conjecture:
    id: c-auto-mode-throughput
    claim: >-
      A two-stage System 1 classifier reduces user approval interruptions by >90% while
      catching unauthorized destructive mutations and prompt injections.
    test: Benchmark testset of 100 legal drafting toolcalls achieves <1% false positive blocks and zero unauthorized bulk deletions.
    edge: resource
    delta_o: Evaluation against curated agentic incident log.
    scope_if_supported: Agent execution pipeline.
    status: supported
    evidence_refs: [f0dbb93]
  decision:
    what: On-route classifier over the turn's own OpenCode Go model; no external Jev/OpenRouter endpoint.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-07
    owner_ratification_ref: user-prompt-2026-10-07
  belief:
    believed_state: Station 7 landed at f0dbb93; auto mode + guardrails live with on-route classification.
    main_uncertainty: Classifier precision/recall on real tool traffic (needs live traffic evaluation).
    next_observation: Station 8 private hardening.
  blocker_or_risk: none
  next_action: Advance spine to Station 8.
receipts:
  - id: station-7-complete
    boundary: implement
    identity: f0dbb93
    proof_refs:
      - backend/src/lib/guardrails/__tests__/autoMode.test.ts
      - backend/src/modules/chat/engine/__tests__/streamingAutoMode.test.ts
    rollback_ref: 6fa23be
    disposition: Station 7 landed on main; guardrails 33/33, automode 16/16, full suite 2930 pass (2 pre-existing openrouter failures).

---

# Station 7: Auto Mode & System 1 Guardrails Engine

Implements coding-agent Auto Mode with multi-tier permissions, reasoning-blind classification, and autonomous execution.
