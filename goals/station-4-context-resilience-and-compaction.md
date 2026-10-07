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
    Eliminate session-crashing tool failures and KV-cache invalidation on the
    OpenCode Go route by implementing layered in-band JSON repair, bounded file
    reads with offset pagination, append-only cache-preserving context management,
    and oh-my-pi-style token-triggered compaction: Snapcompact PNG frames for vision
    models, plain text summary fallback proven on glm-5.3.
  artifact: >-
    backend/src/lib/llm/toolCallParsing.ts (jsonrepair integration & in-band error
    feedback), backend/src/lib/llm/types.ts (LlmUserContent image-part union +
    modelSupportsVision gate), backend/src/modules/chat/engine/tools/documentOps.ts
    (bounded read_document pagination), backend/src/modules/chat/engine/contextBuilders.ts
    (append-only history), and backend/src/lib/compaction/ (token-triggered maintenance,
    snapcompact PNG rasterizer, text fallback).
  acceptance:
    - action: npm test --prefix backend -- src/lib/llm/__tests__/toolRepair.test.ts
      proves: Malformed JSON arguments are repaired deterministically via jsonrepair; unrecoverable syntax errors return in-band tool errors without crashing the turn.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/engine/__tests__/contextCompaction.test.ts
      proves: Context preserves KV-cache prefix across turns, reads documents with bounded offsets, triggers compaction on provider-reported contextTokens > floor(C*thresholdPercent/100) (default 80%, configurable 75-80) checked post-turn / mid-turn at tool-loop boundary / overflow recovery, keeps recent 20k-token tail, and routes vision frames to deepseek-v4.1-flash/muse-spark-1.3-contributor/glm-5.3-flash/minimax-m3/kimi-k3 while glm-5.3 receives text-only summary with no image blocks.
      evidence_class: local_test

value:
  better_means: >-
    Maximize prompt-cache reuse (>90% cache hit rate on the OpenCode Go route)
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
    - OpenCode Go route only. Focus models: deepseek-v4.1-flash, muse-spark-1.3-contributor, glm-5.3-flash, minimax-m3, kimi-k3 (vision); glm-5.3 is the text-only fallback proof with minimal testing.
    - Compaction trigger is token-based (strict >), never turn-count: check post-turn, mid-turn at tool-loop boundary, and on overflow/incomplete-output recovery.
    - Never send image blocks to glm-5.3 or unknown models: fail closed to text summary.

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
    believed_state: Investigation complete including oh-my-pi compaction policy (token-triggered, reserve-aware) and vision audit of the six focus OpenCode Go models.
    main_uncertainty: Optimal native font and frame dimensions for local Bun/Node Snapcompact rendering.
    next_observation: Implement layered JSON repair, LlmUserContent vision union, and token-triggered compaction with glm-5.3 text-fallback proof.
  blocker_or_risk: none
  next_action: Implement Station 4 per updated acceptance; glm-5.3 proves text fallback, vision models prove Snapcompact frames.

receipts: []
---

# Station 4: Context Resilience, In-Band Repair, KV-Cache & Snapcompact

Solves long JSON parsing failures, bounds document reads, preserves KV prefix caching, and integrates Snapcompact multimodal compaction.

## Focus models (OpenCode Go route only)

| model | C | vision | 80% trigger | headroom |
|---|---:|:---:|---:|---:|
| deepseek-v4.1-flash | 1,000,000 | yes | 800,000 | 200,000 |
| muse-spark-1.3-contributor | 1,048,576 | yes | 838,860 | 209,716 |
| glm-5.3 | 1,000,000 | no (text-fallback proof) | 800,000 | 200,000 |
| glm-5.3-flash | 1,000,000 | yes | 800,000 | 200,000 |
| minimax-m3 | 1,000,000 | yes | 800,000 | 200,000 |
| kimi-k3 | 1,048,576 | yes | 838,860 | 209,716 |

Trigger policy (oh-my-pi): `shouldCompact = enabled && strategy != off && C > 0 && contextTokens > floor(C * thresholdPercent / 100)`, strict `>`, default thresholdPercent 80 (configurable 75-80). Measure provider-reported contextTokens minus orchestration tokens, floored by stored-conversation estimate. Keep recent 20k-token tail; summary ceiling 16,384 tokens; post-compaction recovery band 80% of threshold. Idle compaction stays disabled unless explicitly wanted.
