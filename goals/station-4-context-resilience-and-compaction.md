---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-06
  frozen_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-06T23:55:00Z"
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
    Eliminate session-crashing tool failures and KV-cache invalidation by implementing
    layered in-band JSON repair and self-recovery, bounded file reads with offset pagination,
    append-only cache-preserving context management, and Snapcompact vision compaction
    with text fallback at a 75-80% context window threshold.
  artifact: >-
    backend/src/lib/llm/toolCallParsing.ts (jsonrepair integration & in-band error feedback),
    backend/src/modules/chat/engine/tools/documentOps.ts (bounded read_document pagination),
    backend/src/modules/chat/engine/contextBuilders.ts (append-only history & snapcompact integration),
    and backend/src/lib/compaction/ (snapcompact PNG rasterizer and text fallback).
  acceptance:
    - action: npm test --prefix backend -- src/lib/llm/__tests__/toolRepair.test.ts
      proves: Malformed JSON arguments are repaired deterministically via jsonrepair; unrecoverable syntax errors return in-band tool errors without crashing the turn.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/engine/__tests__/contextCompaction.test.ts
      proves: Context preserves KV-cache prefix across turns, reads documents with bounded offsets, and triggers snapcompact/text compaction when exceeding 75% context window.
      evidence_class: local_test
  rollback: git checkout -- backend/src/lib/llm/ backend/src/modules/chat/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Maximize prompt-cache reuse (>90% cache hit rate on Anthropic, OpenAI, and DeepSeek)
    and eliminate "Sorry, something went wrong" turn crashes on long tool arguments,
    while keeping context consumption within bounded token budgets.
  goodharting_would_be: >-
    Purging document bodies every turn to reduce raw memory while destroying the KV cache
    and forcing expensive 1.25x cache write re-prefills on subsequent turns, or silently
    executing truncated tool calls that hallucinate missing arguments.

homotopy:
  realism_axis: >-
    From fragile whole-file dumps, unhandled JSON crashes, and per-turn context eviction (low resolution) to
    layered JSON repair, bounded pagination, append-only prompt caching, and multimodal Snapcompact (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
    - user instruction 2026-10-06 (dedicated context management & compaction mission)
  must_preserve:
    - Never crash the SSE stream on a malformed tool call: feed syntax errors back in-band.
    - Append-only history between compactions: never alter previous turn tokens to maintain prefix cache hash.
    - Snapcompact bitmap frames must preserve exact readable text; fallback to text summary for text-only models.
  excluded:
    - Modifying client-side React rendering components outside message event handlers

now:
  status: working
  slice: context-resilience-and-compaction
  source_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-context-init
    state: ready
    ref: main
    base: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
    digest: none
    scope: [backend/src/lib/llm/, backend/src/modules/chat/engine/, backend/src/lib/compaction/]
  conjecture:
    id: c-append-only-cache-and-repair
    claim: >-
      Combining jsonrepair with in-band syntax feedback eliminates >99% of tool-call crashes,
      while append-only history with Snapcompact reduces latency by ~5x via prefix cache hits.
    test: Live stress test with 50KB tool argument payloads and multi-turn document sessions.
    edge: resource
    delta_o: Benchmark token cache hit rate metrics from model provider response headers.
    scope_if_supported: Core chat streaming engine.
    status: proposed
    evidence_refs: []
  decision:
    what: Use layered JSON parse ladder, append-only history, and Snapcompact with text fallback.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Investigation complete. Root causes identified in streaming.ts, aiSdk.ts, and contextBuilders.ts.
    main_uncertainty: Optimal native font and frame dimensions for local Bun/Node Snapcompact rendering.
    next_observation: Authoring station files and presenting findings to owner.
  blocker_or_risk: none
  next_action: Author Station 5 through Station 10 goal files reflecting the new sequence.

receipts: []
---

# Station 4: Context Resilience, In-Band Repair, KV-Cache & Snapcompact

Solves long JSON parsing failures, bounds document reads, preserves KV prefix caching, and integrates Snapcompact multimodal compaction.
