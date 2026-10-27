# Tabular review

A tabular review extracts a table from a set of documents: each row is a
document, each column a question with an extracted value and its source.

## What the surface does

- **Reviews:** list, create, read, update and delete reviews; list the full ID
  set for select-all. A review has people and access grants like a project.
- **Sources:** attach documents to a review, list its rows, and read the
  extracted cells. `POST /tabular-review/:reviewId/prompt` drafts column
  prompts from the review's purpose.
- **Extraction:** add rows for newly attached documents, seed cells, clear a
  review's cells, regenerate one cell, and run the review generation itself.
  Generation streams over SSE (`POST /:reviewId/generate`,
  `GET /:reviewId/generate/stream`, `POST /:reviewId/generate/stop`) and is
  durable across restarts.
- **Chat:** each review has its own chats, and those turns stream over the
  same durable-run surface (`GET /:reviewId/chats/:chatId/turn/:turnId/stream`).
- **Assistant tool:** `read_table_cells` returns the values a review extracted,
  by column and row.

Tabular reviews are a dormant feature: their tests run nightly rather than
gating a deploy, and their sources are outside the gated coverage measurement
(see [CI](ci.md)).

State as of 2026-10-27; re-read `backend/src/modules/tabular/` before relying
on the route or feature list.
