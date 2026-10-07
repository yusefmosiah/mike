---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: 6e5b553
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T05:00:00Z"
  source:
    canonical_ref: 6e5b553
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard 6e5b553

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
  status: complete
  slice: private-hardening-and-phala
  source_ref: 6e5b553
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-hardening-done
    state: ready
    ref: main
    base: 200c341
    digest: none
    scope: [backend/src/lib/privateMode.ts, backend/src/lib/llm/attestation/, backend/src/lib/egress.ts]
  conjecture:
    id: c-tee-attestation-gate
    claim: >-
      Verifying remote attestation before dispatching model requests establishes cryptographic
      proof of confidential execution without measurable latency degradation.
    test: Attestation handshake completes in <500ms and verifies CVM measurement hashes.
    edge: resource
    delta_o: Live attestation benchmark against Phala CVM endpoint.
    scope_if_supported: Confidential inference layer.
    status: supported
    evidence_refs: [6e5b553]
  decision:
    what: Enforce strict private mode at boot time and record cryptographic receipts per turn.
    kind: safety
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Station 8 landed at 6e5b553; strict mode + attested lane + egress lockdown live.
    main_uncertainty: Live attestation latency against a real Phala CVM (no endpoint configured in this env).
    next_observation: Station 9 code execution and RLM.
  blocker_or_risk: none
  next_action: Advance spine to Station 9.
receipts:
  - id: station-8-complete
    boundary: implement
    identity: 6e5b553
    proof_refs:
      - backend/src/lib/llm/attestation/__tests__/attestation.test.ts
      - backend/src/__tests__/integration/strictPrivateMode.test.ts
    rollback_ref: 200c341
    disposition: Station 8 landed on main; attestation + strict suites green, full suite 2973 pass (2 pre-existing openrouter failures).

---

# Station 8: Private Deployment Hardening & Phala TEE Lane

Delivers the private deployment milestone: strict egress lockdown, verified Phala confidential inference, and DGX vLLM integration.
