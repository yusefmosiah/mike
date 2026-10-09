---
readiness: approved 2026-10-09
---

# Mission 9: Subagent foundation

Owner-approved (2026-10-09). The first workload is **document review**;
citation verification (Mission 6) builds on this later.

## Research basis

- **Pi Durable** provides the primitives: a subagent is a conversation owned by
  the tool call's task (`ownership: { kind: "task", taskId }`); aborting the
  call aborts the child; the parent is idle only once the child is; a
  `{ background: true }` anchor lets a child outlive the parent; request ids make
  a rerun after a crash reuse the same child and submission (README "Abort and
  Subagents", examples 22 and 23).
- **Pi subagent extensions** (coding-agent ecosystem): `pi-subagents`
  (nicobailon: in-process foreground children, detached background runner,
  markdown+frontmatter agent types, fleet view, spawn budget 64);
  `@tintinweb/pi-subagents` (Claude Code style: background by default,
  `steer_subagent`, `@handle` addressing, nesting off by default and capped at
  depth 2, frontmatter authoritative over call parameters, caller models
  checked against enabled models, deterministic `SubagentWorkflow` scripts);
  `yuhua99/pi-subagent` (async, single level).
- **What Pi Durable changes:** those extensions manage sessions on disk,
  detached processes and PID locks. Pi Durable gives durable task-owned
  conversations in Postgres, abort propagation, background anchors and
  restart-safe request ids natively, so none of that machinery is needed.
- **What Mike needs differently:** no working directory, files or worktrees —
  tools act on projects, documents, library and search; authority is the
  user's access, re-checked on every child tool call, never elevated; the
  per-project egress policy applies; findings are legal and business work
  product and carry evidence; the UI is the web app; cost is visible per user.

## Design

- **Tool:** `delegate({ type, task, model?, documents? })`, executed through the
  same dispatcher as every other tool (code mode will call it as a function).
- **Types** are markdown files with frontmatter (`name`, `description`,
  `tools`, `max_rounds`, `max_output_tokens`, `timeout_ms`, instructions body),
  authoritative over call parameters. First type: `document_review`
  (read-only document and search tools).
- **Model:** defaults to the chat model. The caller may pass any model the user
  may use (configured models, strict private mode respected); others are
  refused with the list of allowed ones. The tool description carries a
  **model-selection memo** (`backend/src/modules/chat/engine/subagents/model-memo.md`,
  edited as models arrive) plus a generated table of allowed models with price
  and speed tier.
- **Limits:** depth 1 (no `delegate` inside a child); at most 4 children running
  at once and 8 per turn; per-type rounds, tokens and timeout; child cost rolls
  up into the turn and the audit log.
- **Visibility:** the child is not a sidebar thread. The tool call event
  carries the child id; a collapsed control under the call opens its
  transcript, streamed live and loaded later through an endpoint authorized by
  access to the parent chat.
- **Message records (future-proofing):** every exchange is stored as a typed
  envelope `{ id, from, to, kind: task|steer|followUp|report|finding,
  correlationId, body, artifactRefs }` with a stable address
  (`turn/<assistantMessageId>/<type>-<n>`). v1 uses only `task` and `report`;
  background mailboxes, steering and a shared findings store can be added
  without changing the data.
- **Restarts:** a resumed parent turn rebuilds its child's tools too; the child
  is found again by its owner task.

## Acceptance

- Unit tests: model scope check and default, type loading, depth refusal,
  concurrency and per-turn caps, envelope records, budget enforcement.
- Live: a chat asks for a review of an uploaded document; the parent delegates,
  the child reads the document with its own tools, the parent answers from the
  child's report; the transcript control shows the child's work; the cost of
  both appears.

## Built (2026-10-09, branch `feat/subagents`; not owner accepted)

- `delegate` runs a Pi Durable task-owned child conversation
  (`backend/src/lib/llm/pi/runtime.mts`, "Subagents" section). The child gets
  its type's instructions, its own tools (filtered to the type's list and to
  what the parent was offered), its own round and output-token budgets and a
  timeout. It is never offered `delegate` (depth 1). Records and the
  `task`/`report` envelopes live in Pi docs (`mike.subagent`); a resumed
  parent finds the same child by its owner task and drives it again.
- Types and the model memo are markdown in
  `backend/src/modules/chat/engine/subagents/` (copied into `dist` by
  `backend/scripts/copy-build-assets.mjs`); `subagentHost.ts` checks a call
  and builds the child's spec. `subagentModels.ts` lists the models the user
  may use, with speed tiers and OpenRouter list prices (none fetched in strict
  private mode).
- Wire: a `subagent` event (started, then finished) and a `turn_usage` event
  with the parent's own spend; `GET /chat/:chatId/subagents/:childId` serves
  the child's transcript to anyone who can read the chat.
- Web app: a "Delegated to …" line under the turn's steps shows model, status
  and cost, and opens to the child's task, steps and report. A delegating
  answer shows "This answer: … · N subagents: …" under it.
- Audit: the `chat.message` row carries the turn's own tokens and cost; each
  child adds a `subagent.run` row with its model, tokens and cost (never its
  task text). History labels it "Subagent".

Differences from the design, for review:

- **Parallel since 2026-10-09 (later the same day).** The harness now runs a
  round's lookups at once (`toolExecution: "parallel"`); any tool outside
  `PARALLEL_SAFE_TOOLS` (writes, connector calls, Word client tools,
  ask_inputs) declares `executionMode: "sequential"`, which runs its whole
  round in call order. Several `delegate` calls in one response run their
  children together, up to 4 at once; the rest are told to wait.
- **Costs for flat-rate models are list-price equivalents.** Pi prices
  opencode-go tokens at catalog rates, so the cost line shows dollars for a
  subscription the user does not pay per token. Owner decision: show, relabel,
  or hide for flat-rate lanes.
- The live stream shows the child's start and end; its steps are loaded when
  the line is opened (and again when it finishes), not streamed step by step.

Live check (isolated e2e stack, opencode-go/deepseek-v4.1-flash, public UK
Model Services Contract): the parent delegated, the child read the contract
with `read_document`/`find_in_document`, hit its 8-round limit on the ninth
round and reported; the parent answered with clause citations. Run 1: parent
14,709 in / 5,229 out ($0.0055 list), child 25,874 in / 7,732 out ($0.0090
list), 132 s. Audit rows and stored events matched. The transcript endpoint
answered 200 for the chat and 404 for another chat id. Opened in the browser,
the line expanded to the child's task and steps with no console errors.
