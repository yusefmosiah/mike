# Planted facts across a compaction (2026-10-22)

`backend/evals/compaction-recall/run.mts` builds one synthetic share-purchase
matter on the real Pi runtime: seven turns, each a ~48,000-character excerpt
of a draft agreement, with eight facts planted in the first three. The
owner's auto-compact threshold is set to 20,000 tokens, so the early turns are
compacted. Each question is then asked on its own branch from the last answer,
once with no tools and once with `history_search` and `history_read` offered.
Before the questions, the eval records where each answer still was: in the
summary, still verbatim in the context, or gone.

## Results

Facts planted as ordinary lines of the draft (`--planted clauses`), in the
middle of each excerpt, where the summary's word-for-word record of the
person's messages (head and tail of each) does not reach:

| Model | Summary | Held by the summary / verbatim / gone | Recall, no tools | Recall, history tools | Lookups |
|---|---|---|---|---|---|
| DeepSeek V4.1 Flash | 18,779 chars | 6 / 2 / 0 | 8/8 | 8/8 | 0 of 8 |
| GLM-5.3-Flash | 8,433 chars | 0 / 7 / 1 | 7/8 | 8/8 | 0 of 8 |

An earlier run with each fact marked as the lawyer's note (`--planted notes`)
was 8/8 in both arms on both models: the summary instructions ask for exactly
such statements, and every one was kept.

## What it shows

- **Neither model ever looked anything up.** In 16 questions with the history
  functions on offer, there were no calls, including the one question whose
  answer only the stored history still held. This matches the field: a small
  model in a Pi-based study looked up history in 12 of 79 turns.
- **When the summary drops a fact, the failure is confident.** GLM's summary
  left out the escrow agent. Asked without tools, it answered that "the draft
  SPA doesn't name an escrow agent". The arm with the tools answered correctly
  without calling them, which this run cannot explain (one question, one
  sample); treat it as noise until repeated.
- **The summary carries most of the load.** DeepSeek's longer summary kept all
  six facts it compacted. The ~30,000 tokens kept verbatim held the rest.

## Next

- Repeat with more facts than a summary can hold (dozens, in tool results and
  long messages), several samples per question, and frontier models.
- Measure the closing note's effect on lookups directly: the same questions
  phrased so the model must notice a gap ("what exactly did I say about…").
- If lookups stay near zero, consider a harness-side check: search the history
  for the question's key terms before answering, and offer the hits as turn
  context.

Run: `npx tsx --env-file=.env evals/compaction-recall/run.mts --model
opencode-go/deepseek-v4.1-flash --out recall.jsonl` (about two dozen requests
of 20k to 80k tokens; on OpenCode Go they come out of the subscription's
allowance).
