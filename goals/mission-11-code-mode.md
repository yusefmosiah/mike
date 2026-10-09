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

## First slice, 2026-10-09 (not accepted)

Built on the owner's overnight go-ahead ("make code mode work with
sandboxing"); readiness above is unchanged until the owner reviews it.

- `backend/src/lib/codemode/runScript.ts`: QuickJS (`quickjs-emscripten`
  0.32.0, WebAssembly) in the backend process. The script is the body of an
  async function; globals are `tools` (a proxy over the allowed names) and
  `console`; there is no `process`, `require`, `fetch` or timers. Tool calls
  return promises, so `Promise.all` runs them concurrently. Limits: 64 MiB
  heap, 1 MiB stack, wall-clock deadline (default 120 s, at most 600 s)
  enforced by the interpreter's interrupt handler, 100 tool calls, 20,000
  characters of output; the turn's abort signal cancels the script.
- `run_script` (`CODE_MODE_TOOLS` in `toolSchemas.ts`), offered only when
  `CODE_MODE_ENABLED` is set. `runTurnTools` in `streaming.ts` intercepts it
  and sends each `tools.x(...)` through `runTurnToolsNow` as an ordinary call
  in the same scope, so the Auto Mode gate, the mutation gate (an unwritable
  conversation's script sees no write tools) and the turn's events all apply.
  Writes take turns in the write queue; reads run concurrently. A script
  cannot call `run_script`, `ask_inputs` or the Word add-in's client tools.
- `run_script` is not in the Tier 1 set on purpose: the durable runtime
  replays Tier 1 calls after a crash (`replay: "safe"`), and a script may
  write.

Not yet: `agents.delegate()` (delegation lives in the Pi runtime's subagent
host, not in the tool list), per-tool exposure modes and discovery
(`searchTools`/`describeTool`), `store`/`load`, and a UI for the script and
its inner calls beyond the events those calls already emit.

Receipt (run from `backend/`):

```
$ npx vitest run src/lib/codemode src/modules/chat/engine/__tests__/streamingCodeMode.test.ts
      Tests  18 passed (18)
```

Live receipt, 2026-10-09: isolated local backend (`scripts/e2e-local-stack.sh
--serve-backend`, port 3201, `CODE_MODE_ENABLED=true`), a fresh generated
account, model `opencode-go/deepseek-v4.1-flash`; the probe script records
which tools each turn started and the backend's `[code-mode]` log line.

| prompt | tools the model started | `[code-mode]` log |
|---|---|---|
| table of every workflow's title and column/step count (4 workflows) | `list_workflows`, 4 × `read_workflow` (no script) | none |
| "Use the run_script tool: ... list my workflows, read every one of them in parallel ..." | `run_script` (3 scripts) | `tool_calls: 5, duration_ms: 36`; `2, 4`; `5, 5` |
| "Search the web separately for the 2025 population of each of these ten cities ... Rank them" | `run_script` only | `ok: true, tool_calls: 10, duration_ms: 585` |

On the third prompt the model chose a script without being told to, ran the
ten searches in it, and answered with a ranked, sourced table. With only
four workflows, the first prompt was small enough that it called the tools
directly.
