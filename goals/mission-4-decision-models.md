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
