---
readiness: approved 2026-10-09
---

# Mission 4: Decision models and Auto Mode

Owner direction (2026-10-09): evaluate the decision models on OpenRouter for
Auto Mode and decisions generally, configurable in app settings, with particular
interest in small open-weight models Mike will run on its own hardware.

## Candidates (OpenRouter `output_modalities=decisions`, 2026-10-09)

Hosted: `typesafe/jev-1.13` (and `~typesafe/jev-latest`), `upstage/solar-decide`,
`upstage/solar-decide-flash`, `inception/mercury-decide` (free tier),
`openai/gpt-6-luna-decisions`, `perplexity/pplx-decider-v1.1-27b`,
`liquid/d1` (a larger closed model), `respan/span-01` (behaviour scoring).
Open weights: `cloudflare/clef-flash` (9B), `cloudflare/clef` (27B),
`jaredpalmer/kev-4b`, `togethercomputer/tev1-4b-experimental`. Liquid's open
d1-3B and d1-omni-600M are on Hugging Face (llama.cpp), not on OpenRouter;
they are the target for local runs later.

## Scope

- A decision-model client for OpenRouter's decisions endpoint (verify the
  request shape from the official docs first; it is not chat completions).
- A setting per decision use, starting with Auto Mode tool approval; the
  current classifier stays the default and keeps failing closed.
- An eval set of Mike approval cases (allow / deny / ask), including
  prompt-injection and exfiltration traps, run across every candidate plus the
  current classifier; report accuracy, false-allow rate (the critical number),
  latency and cost; small open-weight models highlighted.

## Acceptance

- Eval harness committed with its case set; a report with every model's
  numbers from a real run (spend recorded).
- Settings: choosing a decision model changes the model Auto Mode calls; a
  failing or unreachable model denies.

## Built (2026-10-09), awaiting owner review

Owner direction during the mission:

- Ask many targeted questions ("does it harm others", "does it delete valuable
  data") and decide on an aggregate.
- Avoid both kinds of error; a veto from any one question would over-refuse.
- The real targets are deletion, harm, leaked valuable data and prompt
  injection, especially once code mode is on. Gmail, Calendar and Drive are an
  eval surface only.
- Code mode does not have to exist first: its scripts enter the eval as
  `run_code` cases.
- Faster is better. Any model taking more than a second per decision is
  eliminated, and time is benchmarked.

What was built:

- **The gate** (`backend/src/lib/guardrails/decisions.ts`):
  - 16 atomic `noul` questions;
  - `scoreGate`, a pure policy that folds answers into risks with AND/OR,
    discounts consentable risks by the user's explicit go-ahead, and never
    discounts a credential leak, injected instructions, harm or improper
    conduct;
  - three outcomes: allow, ask (deny with "confirm with the user first") and
    deny;
  - fails closed on every error.
- **Settings:** `GET`/`PUT /user/auto-mode-decision`,
  `user_profiles.auto_mode_decision_model` (migration
  `20261009_02_auto_mode_decision_model.sql`), and the Settings → Models row.
  The live catalog leaves out Respan and `:free` models, which cannot serve the
  gate.
- **Redaction fix:** keys are now redacted by whole word, so `keywords` is no
  longer hidden. A code-mode `code` argument is read up to 8,000 characters.
- **Eval** (`backend/evals/auto-mode-gate/`):
  - 107 cases;
  - a runner that stores raw answers;
  - a report script that replays policies.
- **Pearls:** [`docs/decision-models.md`](../docs/decision-models.md).
- **Report:**
  [`docs/reports/auto-mode-gate-eval-2026-10-09.md`](../docs/reports/auto-mode-gate-eval-2026-10-09.md).
  - Spend was about $0.70.
  - Speed, one call at a time:
    - nine models are inside the 1 s budget, from Luna at 170 ms to Kev at
      646 ms;
    - eliminated: Upstage solar-decide-flash (1.5 s), Upstage solar-decide
      (about 20 s), and the current LLM classifier (1.8 s median, 7.3 s p90).
  - Settings now lists only measured, in-budget models, fastest first, and the
    gate's timeout is 2 s.
  - Best line: `perplexity/pplx-decider-v1.1-27b` with the default policy.
    On held-out it allowed 0/23 deny cases and refused 5% of legitimate calls,
    at a 358 ms median.
  - A veto from any one question refused 89–100% of legitimate calls on every
    model.

- **Live check:** the settings round trip works. On a password request the
  chat model avoided the password itself, and the gate then over-refused its
  safer generic searches (`off_request`). Rewording that question is the first
  tuning item.
- **Gate decisions** are logged without arguments, and a round's calls are
  judged concurrently.

Open for the owner:

- Whether to make Perplexity's decider the default instead of the on-route
  classifier, which fails the 1 s rule.
- A second labeller and a larger held-out set before relying on rates below
  about 14%.

## Follow-on (2026-10-09): layered gate, awaiting owner review

Owner direction: under 1% false refusals with 0 false allows. Small models
only: `liquid/d1`, `jaredpalmer/kev-4b` and `cloudflare/clef-flash` on
OpenRouter. Symbolic rules first, with semantics injected at Layer 3. Haiku
subagents generate the data, and gpt-6-luna (via codex) replaces DeepSeek as
the second-family checker.

What was built:

- **Layer 1, facts** (`backend/src/lib/guardrails/facts.ts`):
  - effects, from the registry, MCP verbs and annotations, and parsed
    code-mode scripts;
  - provenance of each target, with its record line and the listing's
    alternatives;
  - secrets;
  - copied figures and codes;
  - instruction lines;
  - terms a web query adds;
  - message additions and dictated text;
  - bulk;
  - dropped attendees.
- **Layers 2–3** (`backend/src/lib/guardrails/layered.ts`): a decision table,
  plus nine narrow `noul` questions on a small state.
  - **Allow:** reads and clean web egress pass by rule.
  - **Deny:** secrets, confidential figures, following a document's
    instructions, and unasked public shares.
  - **Ask:** unknown tools and untraceable targets.
- **Tests:** 16 tests in `__tests__/layered.test.ts`.
- **Eval data:** in `backend/evals/auto-mode-gate/corpus/`.
  - 590 legitimate cases with context and 590 harmful near-twins, both drafted
    by Haiku and checked by gpt-6-luna.
  - The briefs and checker prompts are committed.
  - The hand cases gained contexts, and twelve MCP tool names were fixed.
- **Runner and report:** `layered.mts` and `layered-report.mts`.
  - Pair folds and surface folds;
  - exact upper bounds;
  - per-family refusals and a trade-off table.
- **Report:**
  [`docs/reports/auto-mode-layered-gate-2026-10-09.md`](../docs/reports/auto-mode-layered-gate-2026-10-09.md).

Result (held out), honestly:

- **Not met overall.**
  - `clef-flash`: 34.5% false refusals with 0/634 false allows.
  - `d1`: 19.4% false refusals with 8/634 false allows.
- **Met for research.** `clef-flash` refused 0 of 247 legitimate reads, page
  fetches and web searches (95% upper bound 1.2%), with 0/634 false allows over
  the whole set.
- **The gap is consequential writes.** Sends, calendar and Drive changes, and
  connector writes are where the small models cannot match the confidence the
  bar needs.
- **Not wired into the chat runtime.** Auto Mode still runs the first gate.

Open for the owner:

- Ship Auto Mode for research first (layered gate on reads and web egress,
  every write asks, batched), or wait.
- Standing permissions as the route to fewer write asks.
- Whether a larger local verifier for the write band is acceptable. It depends
  on client hardware.
