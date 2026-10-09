---
readiness: later (owner, 2026-10-09)
---

# Mission 11: Code mode

Later mission. Recorded now because current designs must not foreclose it.

Pi 1.0's code mode: the model writes JavaScript that runs in a QuickJS sandbox
with no Node APIs, filesystem, network or timers; tools are `tools.*`
functions; per-tool exposure (`direct`, `codemode`, `deferred`, `hidden`; an
"only" mode hides everything but code mode); discovery through `searchTools`
and `describeTool`; only script output reaches the model; `store`/`load`
commit only when the script succeeds. Code mode is part of the Pi CLI, not Pi
Durable, so Mike embeds QuickJS itself — which also replaces the `node:vm`
sandbox disabled in Mission 0 for exposing the host's environment.

For Mike: with code mode on, most tools become code functions rather than JSON
tool calls; basic ones (reading a document) may stay direct. Every inner call
goes through the same dispatcher and Auto Mode checks as a direct call, and
`delegate` becomes `agents.delegate()`, enabling parallel and pipelined
subagent workflows.
