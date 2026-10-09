---
definition_version: 4
readiness: intent
---

# Search and citations: retained scope

**Incomplete. This file is retained intent, not implementation authorization and
not acceptance.** Original Station 3 was marked done by the overnight run; the
2026-10-07 accounting found the claims overstated and rewrote the baseline
(HEAD `4f0f186`, working tree dirty with unrelated Mission 2 WIP; no mutation is
authorized from here). The owner course in [`STATUS.md`](STATUS.md) decides when
this work runs; [`TRIAGE.md`](TRIAGE.md) §1–3 carries the evidence levels.

## Intended outcome

Modular, multi-provider web search and fetch (`web_search`, `fetch_web_page`)
behind strict egress/SSRF guards, plus citation verification across web sources —
quote grounding and claim entailment — so research cites real, unchanged sources
rather than hallucinated ones.

## What exists now (source, not acceptance)

- Four adapters are present, not absent: Keenable (default), Tavily, Exa and
  Parallel in `backend/src/lib/search/providers.ts`; keys read from
  `KEENABLE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`;
  provider selectable via `SEARCH_PROVIDER` or the tool argument.
- `engine.ts` provides `search`, `fetchPage` (HTML-to-text, SHA-256 content
  hash, 15 s default timeout) and a process-wide in-memory snapshot map;
  `egress.ts` performs the pre-flight scheme check, strict-mode default-deny
  against `PRIVATE_MODE_ALLOWED_EGRESS_HOSTS`, and DNS resolution checked
  against the `privateIp.ts` blocked ranges.
- `web_search` / `fetch_web_page` are registered in `toolSchemas.ts` and
  dispatched in `toolDispatcher.ts`.
- `backend/src/modules/chat/engine/verifyCitations.ts` verifies document, case
  and web quote annotations (normalized substring locating), called from the
  chat stream; web quotes resolve through the same process-local snapshot map.
- Tests on disk (source-implemented evidence only):
  `lib/search/__tests__/search.test.ts`,
  `modules/chat/engine/verifyCitations.test.ts`.

## Open acceptance outcomes

- Real provider QA against live Keenable/Tavily/Exa/Parallel credentials.
- Durable, bounded snapshots: today the map is process-wide, unbounded and lost
  on restart, and web quote verification depends on it.
- Claim entailment, not substring presence: current checking cannot show the
  legal assertion matches the quote.
- Egress closure: search API calls have no strict-mode gate (only `fetchPage`
  is guarded); redirect targets are not re-validated, and DNS is checked
  before, not at, connect time.
- Unified coverage across assistant/tabular/Word surfaces (the tabular citation
  builder bypasses document-citation verification at the current call site).

## Constraints retained

- SSRF protection via `privateIp.ts` on every external fetch.
- `STRICT_PRIVATE_MODE=true`: no external egress without an approved allowlist;
  owner intent keeps controlled source/web retrieval available under privacy
  policy — the requirement is gating, not a blanket ban.
- Excluded: crawling non-public intranet networks without credentials.
- Never validate quotes against changing live URLs instead of immutable content
  hashes.

## Current mapping

STATUS.md "Early cross-cutting work": Station 3 search/fetch/provider QA and
truthful source verification remain basic-functioning priorities; TRIAGE.md
§4 core usefulness course. Citation-checking subagents
(`mission-6-citation-verification-subagents.md`) are a separate future draft;
source acquisition and current citation correctness remain this scope.
