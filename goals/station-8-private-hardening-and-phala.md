---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T23:59:45Z"
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
    Make privacy an enforceable deployment mode with STRICT_PRIVATE_MODE=true, cryptographic
    Phala TEE remote attestation verification, audit receipts, and local DGX Spark vLLM endpoints.
  artifact: >-
    backend/src/lib/llm/attestation/ (CVM verifier), inference_receipts database table,
    catalog lockdown in models.service.ts, and runtimeConfig.ts fail-fast startup checks.
  acceptance:
    - action: npm test --prefix backend -- src/lib/llm/__tests__/attestation.test.ts
      proves: Attested adapter cryptographically verifies measurement and fails closed on tampering.
      evidence_class: local_test
    - action: STRICT_PRIVATE_MODE=true npm test --prefix backend -- src/__tests__/integration/strictPrivateMode.test.ts
      proves: Hosted cloud providers, telemetry, and unapproved external models are completely rejected at startup.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/llm/attestation/ backend/src/lib/runtimeConfig.ts
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Guarantee client matter confidentiality by enforcing that zero privileged prompt or document
    tokens ever reach unverified external cloud endpoints.
  goodharting_would_be: >-
    Showing a "private" UI toggle while allowing background analytics or automatic cloud fallback.

homotopy:
  realism_axis: >-
    From unverified OpenAI-compatible HTTP endpoints (low resolution) to
    cryptographically attested GPU CVM lanes with immutable audit receipts and egress lockdown (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Fail-closed: if Phala attestation fails, request fails immediately; never fallback to public cloud.
    - Zero prompt or response text recorded in inference_receipts table.
  excluded:
    - Developing custom hardware TEE microcode

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
    id: c-tee-attestation-gate
    claim: >-
      Verifying remote attestation before dispatching model requests establishes cryptographic
      proof of confidential execution without measurable latency degradation.
    test: Attestation handshake completes in <500ms and verifies CVM measurement hashes.
    edge: resource
    delta_o: Live attestation benchmark against Phala CVM endpoint.
    scope_if_supported: Confidential inference layer.
    status: proposed
    evidence_refs: []
  decision:
    what: Enforce strict private mode at boot time and record cryptographic receipts per turn.
    kind: safety
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 7.
    main_uncertainty: Phala CVM attestation certificate rotation cadence.
    next_observation: Testing CVM verification against staging Phala testnet.
  blocker_or_risk: Blocked on completion of Station 7.
  next_action: Await Station 7 completion.

receipts: []
---

# Station 8: Private Deployment Hardening & Phala TEE Lane

Delivers the private deployment milestone: strict egress lockdown, verified Phala confidential inference, and DGX vLLM integration.
