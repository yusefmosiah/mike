---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T21:35:00Z"
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
    Provide a modular, multi-provider web search and fetch interface (supporting Keenable,
    Tavily, Exa, and Parallel) wrapped in strict egress/SSRF guards, and extend existing
    citation verification to web sources and claim entailment.
  artifact: >-
    backend/src/lib/search/ (modular engine and egress guards), updated
    backend/src/modules/chat/engine/verifyCitations.ts with web quote grounding and
    entailment checks, and web_search tool in toolSchemas.ts.
  acceptance:
    - action: npm test --prefix backend -- src/lib/search/__tests__/search.test.ts
      proves: Multi-provider adapter parity, SSRF IP blocking, and timeout handling across Keenable/Tavily/Exa/Parallel.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/engine/__tests__/verifyCitations.test.ts
      proves: Verification of quotes against retained web snapshots and detection of unsupported claims.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/search/ backend/src/modules/chat/engine/verifyCitations.ts
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Enable grounded web research across modern search APIs while eliminating hallucinated
    citations and preventing arbitrary external egress under strict private mode.
  goodharting_would_be: >-
    Validating citations against changing live URLs instead of immutable content hashes,
    or verifying substring presence without checking that the legal assertion matches the quote.

homotopy:
  realism_axis: >-
    From zero web search and document-only quote matching (low resolution) to
    multi-provider search with cached web snapshots, SSRF guards, and entailment checking (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - SSRF protection via privateIp.ts on all external fetch requests.
    - Zero outbound egress allowed under STRICT_PRIVATE_MODE=true unless an approved gateway is configured.
  excluded:
    - Crawling non-public intranet networks without credentials

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
    id: c-modular-search-grounding
    claim: >-
      Caching fetched web snapshots and verifying quote substrings before rendering citations
      eliminates web hallucinations in legal memos.
    test: Citations with altered quotes fail verification and are flagged in stream output.
    edge: resource
    delta_o: Synthetic citation verification test suite.
    scope_if_supported: Assistant research engine.
    status: proposed
    evidence_refs: []
  decision:
    what: Support Keenable as primary search provider with Tavily, Exa, and Parallel adapters.
    kind: operational
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: verifyCitations.ts already handles document and CourtListener quotes cleanly.
    main_uncertainty: Entailment verifier latency and whether it requires a fast local model or heuristic check.
    next_observation: Testing fast entailment scoring using System 1 classifier.
  blocker_or_risk: Blocked on completion of Station 2.
  next_action: Await Station 2 completion.

receipts: []
---

# Station 3: Modular Search & Extended Citation Verification

Builds a provider-agnostic search engine and extends citation verification to web pages and legal claims.
