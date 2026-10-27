# Subagents

The assistant can hand a self-contained task to a subagent and use the report
in its answer. A subagent gets its own Python session and a subset of the
parent's tools; it cannot delegate further or ask the person questions.

## Delegation

`delegate` (a function available from the assistant's Python session) takes a
subagent type, a self-contained task, and optionally a model and document ids.
The type file fixes the allowed tools, tool rounds, output-token budget and
wall-clock limit; the call cannot widen them. A synchronous delegation returns
the report to the parent turn.

## Background subagents

With the background feature enabled, `delegate` also accepts
`background: true`. The call returns at once with the subagent's name; the
subagent keeps working after the parent answers, and its report arrives in the
chat when it finishes. A background subagent may work in 30-minute pieces
until it is stopped or the chat ends.

- `list_agents` — names, type, model, status, task, last report and unread
  message count.
- `message_agent` — redirect a working subagent, or give a finished one more
  work. A subagent may message the chat or another subagent.
- `agent_inbox` — collect unread reports, optionally waiting up to 600 seconds.
- `stop_agent` — stop the current work; the subagent keeps what it has done.

Background subagents are experimental and off by default (Settings →
Features). A restart ends them, and the chat is told which were cut off.

State as of 2026-10-27; re-read `backend/src/modules/chat/engine/subagents/`
and the tool schemas before relying on limits or tool names.
