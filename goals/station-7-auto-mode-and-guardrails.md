---
definition_version: 4
readiness: intent
---

# Auto Mode and guardrails: retained scope

**Incomplete. This file is retained intent, not implementation authorization and
not acceptance.** Permission tiers and the on-route classifier exist in source,
but the requested development/private split is not delivered and real-scenario
acceptance is not established in the reviewed record. Baseline: HEAD `4f0f186`,
working tree dirty with unrelated Mission 2 WIP; no mutation is authorized from here.

## Intended outcome

Coding-agent Auto Mode that removes per-write approval fatigue while denying
destructive, exfiltrating or out-of-scope tool calls — reasoning-blind and
fail-closed, with deny-and-continue so the model recovers in-band instead of
the turn ending.

## What exists now (source, not acceptance)

- `backend/src/lib/guardrails/policy.ts`: Tier 1 reads / pure computation
  (always allowed); Tier 2 document writes allowed only with the caller's
  document-mutation authorization (`allowDocumentMutation`) and arguments
  inside the turn's own container (`inScopeForContainer`); Tier 3 is everything
  else — connector writes, `web_search` / `fetch_web_page`, `ask_inputs`,
  unknown names — judged by the classifier.
- `classifier.ts`: a single on-route completion (same provider/key/model family
  as the turn; fallback model `opencode-go/glm-5.3-flash`; 15 s timeout);
  reasoning-blind (user intent + tool name + redacted args + prior tool names
  only); fails closed to `deny` on throw, timeout or unparseable verdict.
- `streaming.ts`: per-turn `auto_mode` opt-in (chat and project-chat routes);
  refusals are returned in-band as tool results so the turn continues;
  `ask_inputs` is withheld and auto-answered with `AUTO_MODE_SAFE_DEFAULTS`
  (approval items are denied); prior tool names are tracked so a denied call
  cannot be laundered under another name.
- Mission 0 (2026-10-07): `execute_code` disabled (refusal stub, no longer
  advertised or dispatched); `web_search` / `fetch_web_page` removed from
  Tier 1.
- Tests on disk (source-implemented evidence only):
  `lib/guardrails/__tests__/autoMode.test.ts`,
  `modules/chat/engine/__tests__/streamingAutoMode.test.ts`.

## Open acceptance outcomes

- Real allow/ask/deny behavior, classifier failure, read-vs-write scope and
  prompt-injection scenarios on live tool traffic. No precision claim is
  retained: the overnight ">90 % fewer interruptions / <1 % false-positive"
  benchmark was never run.
- Manual/client choice: no frontend enable surface for `auto_mode` is evidenced
  in source; only request-body callers set it.
- The classifier lane is unresolved. Current code classifies on-route, while the
  owner's development/private split names Jev/OpenRouter for development and a
  local System 1 classifier for production; STATUS.md agenda item 4 records the
  conflict and no OpenRouter/Jev lane is evidenced. Neither side is settled by
  this file, and the choice concerns the classifier lane only — it does not
  authorize external orchestration.

## Constraints retained

- Reasoning-blind design: assistant prose never reaches the classifier.
- Deny-and-continue: blocked actions return in-band errors so the turn does
  not crash.
- Fail closed on classifier failure, timeout or unparseable output.
- Unattended RLM: a long run must never pause on `ask_inputs`.
- Excluded: blanket skip-permissions modes and modifying connector OAuth
  scopes.

## Current mapping

Mission 4 (STATUS.md agenda item 4). TRIAGE.md records the current on-route
implementation, missing requested OpenRouter/Jev lane and unresolved routing/
permission acceptance. The stale "settled" claim is not retained.
