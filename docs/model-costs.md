# Model costs: which model does what

Mike's hosted deployments run on server keys for OpenCode Go and OpenRouter, so
every model call is the deployment's money. This page states the principle
behind the default model choices, with the prices it rests on. Prices are from
[OpenCode Go's docs](https://opencode.ai/docs/go) and
[models.dev](https://models.dev/api.json), read on 2026-10-10; re-read them
when choosing a new default.

## How the two providers bill

- **OpenCode Go is a flat subscription**: $10 a month (Go Plus: $40). Each
  model has its own monthly allowance, stated in dollars and spent at that
  model's token prices. Its usage is also capped at 20% of the monthly
  allowance per 5 hours and 50% per week. Within an allowance, one more call
  costs nothing extra.
- **OpenRouter bills per token**, with no ceiling. Every call is new money, and
  the same open model often costs more there than on OpenCode Go (DeepSeek
  V4.1 Flash: $0.30 in / $1.20 out per million on OpenRouter, $0.15 / $0.60
  off-peak on Go).

## What a model costs on Go ($10 plan, per million tokens)

| Model | Input | Output | Monthly allowance |
|---|---|---|---|
| Muse Spark 1.3 Contributor (regional) | $0.10 | $0.20 | $60 |
| MiMo-V2.6-Flash | $0.14 | $0.28 | $60 |
| GLM-5.3-Flash | $0.15 | $0.50 | $60 |
| DeepSeek V4.1 Flash (off-peak; peak is double) | $0.15 | $0.60 | $60 |
| GLM-5.3 | $1.40 | $4.40 | $15 |
| Qwen3.8 Max | $2.00 | $6.00 | $15 |
| Kimi K3 | $3.00 | $15.00 | $15 |

A flash model costs about a tenth of a premium one per token, and it gets four
times the allowance. On the same $10 that is roughly forty times as many calls.
Each model's allowance is separate, so spreading work over several flash models
multiplies what the plan covers. For comparison, frontier models billed per
token run $4 / $20 (Claude Opus 5.5) to $10 / $50 (GPT-6 Astra), 25 to 100
times the flash prices. Output costs two to five times input, so long answers
and heavy thinking spend a budget fastest.

## The principle

1. **Volume work runs on subscription flash models.** Any work that makes many
   calls nobody chose a model for: citation checks (two calls per citation),
   chat titles, memory curation, classifier fallbacks, document diligence.
   The list is `OPENCODE_FLASH_MODELS` in `backend/src/lib/llm/models.ts`:
   DeepSeek V4.1 Flash, GLM-5.3-Flash, Muse Spark 1.3 Contributor.
2. **When a flash model fails or its allowance runs out, hand over to the next
   flash model,** not to a pay-per-token one. The citation checker does this
   (`citations.tasks.ts`).
3. **Pay per token only where a few tokens buy accuracy that matters.** The
   Auto Mode gate's decision models run on OpenRouter
   ([decision-models.md](decision-models.md)). They are small calls with high
   stakes.
4. **The person's own choice wins.** A model someone selects for a chat, or
   saves in settings (title, tabular or curator model), is used as chosen.
   Defaults only fill gaps. A new person with nothing chosen starts on the
   first flash model they can run, and their OpenCode Go model list starts as
   the three flash models until they save their own.
5. **Never default a multi-call feature to the conversation's model.** It may
   be a premium model, and the feature multiplies its price.

## Where the defaults live

- Backend: `OPENCODE_FLASH_MODELS` and `flashModelsFor()`
  (`backend/src/lib/modelSelection.ts`), used by the citation checker, title
  generation for OpenCode Go chats, the memory curator and the default OpenCode
  Go selection (`backend/src/lib/routerModels.ts`). The classifier and
  diligence defaults (`opencode-go/glm-5.3-flash`) predate the list.
- Frontend: `PREFERRED_FIRST_MODEL_IDS` in
  `frontend/src/app/hooks/useSelectedModel.ts`.
- Overrides: `CITATION_CHECK_MODEL` and `MEMORY_CURATOR_MODEL`.
