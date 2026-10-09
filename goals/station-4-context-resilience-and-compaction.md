---
definition_version: 4

readiness: drafted


start:
  captured_at: "2026-10-07"
  correction: >-
    Replaces the stale clean-tree/deployed-baseline claim from the overnight goal.
    The implementation receipts below describe the local Mission 2 candidate,
    not acceptance of the running Docker deployment.
  source:
    canonical_ref: 4f0f1867ed81c2cf50c6da1c60cd2650785264cd
    deploy_identity: not-deployed-local-node-verification
  worktrees:
    - path: /Users/wiz/mike
      status: dirty
      class: goal_candidate
      owner: user-directed-mission-2
      touch: preserve
      recovery: Preserve candidate source, tests and probe; no hard reset or automatic stash.

finish:
  deliver: >-
    Repair malformed tool arguments in-band, bound document reads and trigger
    compaction in the OpenCode Go streaming adapter, with text-only fallback
    and safe overflow recovery. Durable cross-turn history and measured cache
    performance are separate open outcomes; this candidate does not deliver them.
  artifact: >-
    backend/src/lib/llm/toolCallParsing.ts (in-band argument repair),
    backend/src/lib/llm/aiSdk.ts and conversationCompaction.ts (preflight,
    completed-step checkpoints and bounded overflow recovery),
    backend/src/lib/compaction/ (token policy, bounded ASCII archives and
    Unicode text fallback), backend/scripts/probe-compaction.ts (live probe),
    and bounded read_document pagination.
  acceptance:
    - action: npm test --prefix backend -- src/lib/llm/__tests__/toolRepair.test.ts
      proves: Malformed JSON arguments are repaired deterministically via jsonrepair; unrecoverable syntax errors return in-band tool errors without crashing the turn.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/lib/llm/aiSdk.compaction.test.ts src/lib/llm/aiSdk.compactionVision.test.ts src/lib/llm/aiSdk.toolErrors.test.ts src/lib/llm/conversationCompaction.test.ts src/modules/chat/engine/__tests__/contextCompaction.test.ts
      proves: >-
        Actual adapter checkpoints fire on provider usage and oversized tool
        output; strict threshold and configured 75/80 behavior; byte-identical
        replay prefixes; complete call/result identity; one explicit overflow
        recovery; no unsafe retry of uncheckpointed tools; text-only recovery
        continuation; PNG transport and Unicode/oversized archive fallback.
      evidence_class: local_test
    - action: cd backend && npx tsx scripts/probe-compaction.ts
      proves: >-
        A synthetic 3.74-million-character conversation reaches the real
        OpenCode Go GLM route as compacted text, executes the schedule tool
        once, and answers with its returned deadline.
      evidence_class: live_provider_probe

value:
  better_means: >-
    Reduce tool-argument and context-overflow failures while preserving complete
    tool pairs, active request intent and stable supplied prefixes.
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
  status: awaiting_owner_review
  slice: mission-2-streaming-compaction
  source_ref: 4f0f1867ed81c2cf50c6da1c60cd2650785264cd
  deploy_identity: not-deployed-local-node-verification
  candidate:
    id: candidate-mission-2-compaction
    state: ready
    ref: working-tree
    base: 4f0f1867ed81c2cf50c6da1c60cd2650785264cd
    digest: d59a1df56e7c65bf99ab3000e4f6fc77fe407b3d2ad0c256ca48ed1697964369
    scope: [backend/src/lib/llm/, backend/src/lib/compaction/, backend/src/modules/chat/engine/, backend/scripts/probe-compaction.ts, backend/.env.example]
  conjecture:
    id: c-append-only-cache-and-repair
    claim: >-
      Adapter checkpoints keep long tool sessions usable without silently losing
      active intent or re-executing effects.
    test: Threshold, tool-pair and overflow cases plus live text-provider probe.
    edge: missing_oracle
    delta_o: Real multi-turn/archive and vision-provider scenarios beyond the recorded text probe.
    scope_if_supported: Known OpenCode Go focus routes within an adapter invocation.
    status: supported
    evidence_refs: [receipts]
  decision:
    what: Compaction/text-fallback requirements are owner-directed; runtime architecture remains open.
    kind: requirement
    status: settled
    evidence_ref: user-instruction-2026-10-07-mission-2
    owner_ratification_ref: user-instruction-2026-10-07-mission-2
  belief:
    believed_state: Adapter behavior, vision transport, overflow safety, backend build and a live GLM session verified.
    main_uncertainty: Provider-usage-only checkpoints are invocation-local; only estimate-triggered checkpoints replay across requests.
    next_observation: Owner review of Mission 2.
  blocker_or_risk: >-
    Dated test-only typecheck errors below; later default-worker corpus timeouts
    versus a reduced-worker passing run are recorded in TRIAGE.md, not diagnosed here.
  next_action: Owner review; no owner acceptance claimed.

receipts:
  - action: npm test --prefix backend -- src/lib/llm/aiSdk.compaction.test.ts src/lib/llm/aiSdk.compactionVision.test.ts src/lib/llm/aiSdk.toolErrors.test.ts src/lib/llm/conversationCompaction.test.ts src/modules/chat/engine/__tests__/contextCompaction.test.ts
    result: "Test Files 5 passed (5); Tests 114 passed (114)."
  - action: npm run build --prefix backend
    result: "tsc; exit 0."
  - action: npm test --prefix backend -- --maxWorkers=2
    result: "Test Files 232 passed, 7 skipped; Tests 4301 passed, 51 skipped."
  - action: "node_modules/.bin/tsx scripts/probe-compaction.ts (cwd backend)"
    result: "INPUT chars 3740144; OUTBOUND bytes 65856 then 66261, compacted true, hasImages false; ANSWER The deadline returned by the schedule is 2026-10-21.; LIVE PROBE PASSED modelRequests 2, toolExecutions 1."
  - action: npm run typecheck:test --prefix backend
    result: "Exit 1: audit.test.ts:65 TS2769; pdfText.test.ts:125 TS2835; rlmDeepRun.test.ts:32 TS2556. All three paths untouched."
---

> **Status (2026-10-07): awaiting owner review.** Mission 2 integrates the
> previously unwired compaction policy. [`goals/STATUS.md`](STATUS.md) remains
> the authoritative agenda; neither the agent nor the panel accepts for the owner.

# Station 4: Context Resilience, In-Band Repair, KV-Cache & Snapcompact

Implements bounded argument repair and adapter compaction. Preserving supplied
prefixes does not establish end-to-end cross-turn KV-cache reuse or raw-history retention.

## Focus models (OpenCode Go route only)

| model | C | vision | 80% trigger | headroom |
|---|---:|:---:|---:|---:|
| deepseek-v4.1-flash | 1,000,000 | yes | 800,000 | 200,000 |
| muse-spark-1.3-contributor | 1,048,576 | yes | 838,860 | 209,716 |
| glm-5.3 | 1,000,000 | no (text-fallback proof) | 800,000 | 200,000 |
| glm-5.3-flash | 1,000,000 | yes | 800,000 | 200,000 |
| minimax-m3 | 1,000,000 | yes | 800,000 | 200,000 |
| kimi-k3 | 1,048,576 | yes | 838,860 | 209,716 |

Normal trigger: OpenCode Go focus route, known `C > 0`, and `contextTokens > floor(C * thresholdPercent / 100)` (strict `>`). `LLM_COMPACTION_THRESHOLD_PERCENT` defaults to 80 and is clamped to 75–80. Use the latest provider context usage minus reported orchestration tokens, floored by the message estimate plus system/tool/media allowance. Keep the recent 20k-token tail, subject to explicitly summarizing an oversized completed tool output; text-summary ceiling 16,384 tokens; recovery band 80% of the trigger. Explicit overflow may force a real reduction below the normal trigger. No idle compaction.

## Mission 2: implemented behavior

The shared streaming adapter covers web, project, Word and tabular chat when
the selected provider is OpenCode Go and its model has a known focus window.
Other provider routes remain unchanged.

- **Preflight:** deterministic replay of historical estimate-triggered
  checkpoints. Appending a turn preserves the earlier compacted prefix.
  There is no global mutable cache and no transcript deletion.
- **Completed-step checkpoints:** latest provider prompt-plus-output usage,
  floored by the conversation estimate and fixed system/tool overhead.
  Media allowances also participate in the retained-tail split and replay.
  The next SDK step receives the checkpoint, not the unbounded expansion.
- **Overflow:** one retry for explicit context-overflow prose or canonical
  `context_length_exceeded` / `context_window_exceeded` codes, after a real
  reduction. Authentication, quota, output limits, cancellation and tool
  faults do not qualify. Completed tool pairs and already emitted prose
  survive. Any actual tool dispatch not yet committed into the transcript
  prevents recovery; aborting a stream does not cancel its side effects.
- **Oversized newest tool output:** a completed result that cannot fit is
  explicitly summarized, retaining call input/name/id and result identity.
  Extractive anchors and a final excerpt remain; the marker says full data
  was omitted and requests targeted/paginated re-reading if needed. Ordinary
  recent results remain verbatim.
- **Archives:** positively declared vision models receive bounded ASCII-safe
  PNGs when archive headroom is available. Unicode, oversized, or
  budget-constrained archives use the Unicode text summary, never substituted
  bitmap glyphs. The live probe proves the text lane; adapter tests prove
  vision transport.
- **Configuration:** `LLM_COMPACTION_THRESHOLD_PERCENT`, default 80, clamped
  to 75–80. Empty or invalid values use 80. The comparison remains strict `>`.
  There is no idle compaction.

### Limits and verification failures

A checkpoint triggered only by provider usage is retained within that
invocation, not durably stored. A subsequent request replays estimates and
may resend the raw history before usage or overflow causes another
checkpoint. This is a cache-efficiency limitation, not a claim of durable
checkpoint persistence or a measured >90% cache hit rate.

The owner's upstream/OptChat comparison identifies a separate persistence
boundary. Current `chat.prepare.ts` still calls `enrichWithPriorEvents`;
that helper reads the newest persisted assistant bundle and appends
`[Tool activity in your previous turn]`, not the original call arguments and
tool outputs. Persisted assistant rows hold display events (labels, document
ids, versions), not tool-call/tool-result messages, and HTTP parsing accepts
no tool parts, so no prior result body crosses a turn boundary. Mission 2
preserves complete working tool units within an invocation and compacts the
supplied transcript; it does not create a durable raw agent log or
retrievable immutable archive. Snapcompact PNGs and summaries exist only as
in-memory prompt representations, not lossless archival storage. The
The proposed three tiers—working context, retrievable conversation originals,
and curated `memory.md`—remain distinct; the archival tier is separate work.

One KV-cache detail to fix when the trajectory becomes append-only:
`enrichWithPriorEvents` appends the `[Tool activity in your previous turn]`
block to the last assistant message of each request and derives it from the
newest persisted assistant row, so the same historical message carries the
recap in one request and not the next. The token prefix therefore diverges
at that position on every turn, forcing cache writes for the prior turn's
prose. Cheap today because prompts omit tool payloads; expensive once a
persisted tool trajectory lengthens the prefix. Append the recap as its own
message (or persist it) so prior messages stay immutable.

Default-worker full runs intermittently hit the unchanged 20-second DOCX
corpus timeout: two cases initially, one after the final recovery repair.
An intermediate default-worker run passed. The latest entire suite passed
with `--maxWorkers=2`, without changing DOCX code, test timeouts, or exclusions.
Concurrency sensitivity is observed; its specific cause is not established.
Test-only TypeScript checking still fails at the three untouched paths listed
above; production TypeScript builds pass.

### Initial consensus and adjudication

The default ten-member panel was attempted after implementation and live
verification. Six members returned substantive reviews: Codex, OMP
GPT-6.1-sol, GPT-6-luna, Gemini, Muse and DeepSeek. All six default OMP model
pins were identity-probed successfully before the review. Devin exited zero
without a verdict after a tool-confirmation rejection; Claude authentication
failed; OpenCode's configured image model required balance; GLM timed out.
Those four runs are not counted as positive reviews.

Codex and the flagship identified the newest-result overflow and code-only
overflow gaps; both were fixed and exercised. Their same-step side-effect
race was a static concern: no duplicate was observed in probes, but recovery
now refuses uncheckpointed immediate or deferred dispatches. Minority safety
findings were not overridden by the four accepting reviews.

Other recommendations implemented: partial-prose continuation, vision
transport and archive fallback coverage, original-transcript immutability,
consistent media budgeting, runtime threshold configuration, impossible
prefix short-circuits, and obsolete-hook/comment removal.

A second four-member review (Codex, flagship, Luna, Gemini; all ran) found
two additional edge cases. Four new adapter regressions reproduced them:
output-cap or validation metadata was misclassified as input overflow, and
a large active request left less room than the fixed result-summary budget.
The classifier now requires an actual exceeded/too-long diagnostic or
canonical code, rejects explicit output caps, and still permits genuine
combined prompt/completion context overflow. Result bodies are sized against
remaining headroom after call/result/media/message overhead and summary
notice/serialization slack. All four regressions pass; a fifth protects the
genuine combined-context case.

The third three-member review ran successfully. Codex accepted; the flagship
found that metadata could still proximity-match unrelated `exceeds` wording;
Luna found that generated summaries duplicated retained content and were not
budgeted with the protected request. Five failing adapter regressions
confirmed both findings. Four more reproduced plain-prose and wrapped-403
false positives. All nine now pass, alongside an additional native numeric
overflow case without a reduce-message instruction.

Classification now inspects individual diagnostic fields, not serialized
metadata or text joined across fields. Prose binds exceeded/too-long wording
to input/context; numeric requested counts must exceed the stated maximum.
Known HTTP statuses other than 400/413 disqualify the entire error chain.
The shared compactor reserves system/tool overhead and protects live/pending
units, summarizes only actual discarded history, and budgets that summary
and archive media against remaining headroom. The full-transcript near-band
regression preserves the active request and tool pair, recovers below the
synthetic provider limit, and executes the tool once.

The repaired candidate is frozen against base
`4f0f1867ed81c2cf50c6da1c60cd2650785264cd`. Its ordered eleven-file SHA-256
manifest hashes to
`d59a1df56e7c65bf99ab3000e4f6fc77fe407b3d2ad0c256ca48ed1697964369`.
Scope: `aiSdk.ts`, its compaction and vision tests,
`conversationCompaction.ts` and its tests, compaction `index.ts`/`policy.ts`,
`contextBuilders.ts`, the existing context-compaction tests, the live probe,
and `backend/.env.example`. All unrelated owner work is excluded; agenda
documentation is excluded from this code fingerprint.

The fourth-round confirmation panel ran on the independent Antigravity and
OpenCode Go routes after all three Codex-route reviewers returned
`usage_limit_reached` until 18:10. Gemini-3.8 and DeepSeek-V4-pro both
accepted with no blocker: each independently verified the eleven-file
manifest, re-derived the constrained classifier against the prior
counterexamples, and re-derived the recovery-budget fixed point for the
near-band boundary case. Claude-Opus-4.6 failed at launch and Kimi-K3 timed
out at the 600-second limit; neither produced a verdict. Residual risks both
reviewers named are fail-closed: the 520-token summary reservation may
under-reserve and cause a conservative no-change, never an overshoot; the
256-token reduction floor bounds recoverability; and the 4-chars/token
estimate remains approximate. No reviewer found a new counterexample.

`git diff --check` flagged one trailing blank line at EOF in
`contextCompaction.test.ts` and in this file; both were removed. The manifest
was re-frozen after that whitespace-only edit, so the reviewed aggregate
(`f6784583…`) differs from the final aggregate
(`d59a1df56e7c65bf99ab3000e4f6fc77fe407b3d2ad0c256ca48ed1697964369`) only by
that removal, and the two touched test files were re-run afterwards
(64 tests passing).

Local raw artifacts: `.agentic-consensus/mission2-review/`,
`mission2-candidate.sha256`, `mission2-repaired.sha256`, `mission2-final.sha256`,
`mission2-headroom.sha256`, `mission2-tail.sha256`, evidence files, and the
repaired/final/headroom/tail review directories under `.agentic-consensus/`.
This goal file retains the acceptance receipts,
candidate identity, reviewer health and adjudication when ignored local
diagnostics are unavailable.
