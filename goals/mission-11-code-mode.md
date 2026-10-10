---
readiness: required (owner, 2026-10-10)
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

## Owner decisions, 2026-10-10

- **Code mode is a full requirement.** The model reaches every tool through
  Python, including asking the user and the Word add-in's tools.
- **No shadow or dual mode.** Verify code mode with scenario tests and trace
  review instead, then go all in.
- **Plain Python code mode now; the RLM pattern later.** Context as variables
  and sub-model calls from code, once affordable open models handle it. Keep
  the door open now.
- **Every user has a VM.** Boutique firms; staging runs the harness and the VMs
  on node-a, and production may split them across two machines.
- **Target work:**
  - overnight research runs over a NAS of terabytes and, later, a vector
    database;
  - web data (for example SEC filings) analysed with Python alongside firm
    data;
  - reports and documents written and updated;
  - email sent (the firm's own mail server later). The system is meant to
    grow.
- **Off-machine backups, immutable logs, security hardening and auth** wait
  for a non-functional pass after the owner's demo with their partner. For
  now: functional and usable.
- Wide and deep research on performance, memory, security and alternatives,
  run with Sonnet:
  [`docs/reports/code-mode-deep-research-2026-10-10.md`](../docs/reports/code-mode-deep-research-2026-10-10.md).
  Its first action item, Cloud Hypervisor v52.0 or later on node-a, already
  holds: the only Cloud Hypervisor build in node-a's Nix store is
  `cloud-hypervisor-52.0`. Its security measures (outbox approval, egress
  following the data, taint bit) belong to the later non-functional pass
  unless the owner pulls them forward.

## Python code mode, 2026-10-10 (not accepted)

Built on the owner's decision above. Readiness stays as the owner set it
until they review this.

- **The kernel** (`backend/src/lib/codemode/kernel/mike_kernel/`): Mike's own
  persistent CPython REPL, protocol in `PROTOCOL.md` there, design credited to
  Prime Agent and OMP in `CREDITS.md` (no code copied). Newline-delimited JSON
  over stdin and stdout; top-level `await` on one event loop; tool calls go
  to the harness as `host_request` frames on the same channel; output tagged
  per cell, subprocess output included; interrupts reach both blocking and
  awaiting code; `SystemExit` and `KeyboardInterrupt` end only the cell;
  `input()` reads end-of-file; a cell sent on one line with literal `\n`
  escapes is repaired when that parses (the failure mode the research found
  in smaller models). Namespace snapshots with dill, one variable at a time,
  and a final snapshot when the harness disconnects; without dill the kernel
  works and snapshots are off.
- **The harness side** (`backend/src/lib/codemode/kernel/*.ts`): every frame
  is parsed as untrusted (16 MiB line cap, shape checks). A session's time
  limit counts the cell's own time only and stops while a tool call is with
  the harness; at the limit, or when the turn is cancelled, the cell is
  interrupted and the kernel killed 5 s later if it does not stop. Tool calls
  from a task the cell left running are refused. The kernel's files travel in
  the ssh command and install under `~/.mike/kernel/<hash>/` in the VM.
  `KernelManager` keeps one kernel per conversation across turns, snapshots
  after each cell, restores when it starts a new kernel, stops kernels idle
  for 30 minutes, and counts a VM as down for a minute after a kernel fails
  to start.
- **The tool** (`run_python`, `backend/src/lib/codemode/python.ts`): offered
  alone to every user with a workstation VM (`CODE_MODE_ENABLED=false` turns
  it off). Every other tool the turn would have offered is documented in the
  system prompt as a Python signature (`TOOLS IN PYTHON`) and bound as
  `await tools.<name>(...)` in the kernel. Each call goes through
  `runTurnToolsNow` like a direct call: Auto Mode gate, mutation gate, events,
  write queue, Word add-in client tools. `ask_inputs` and connector approvals
  end the cell with `UserQuestionPending` (a `BaseException`, so `except
  Exception` cannot swallow it) and then pause the turn; the variables wait
  for the answer. `run_command` is not offered in Python, where `subprocess`
  does its job. Subagents still call tools directly. The first cell of a turn
  takes the workstation snapshot, as `run_command` does. When the VM cannot
  be reached, the cell says so and the next turns get the direct tools for a
  minute.
- **Retired:** the QuickJS `run_script` slice of 2026-10-09 and the
  `quickjs-emscripten` dependency.
- **Development without a VM:** `CODE_MODE_LOCAL_KERNEL_DIR` runs kernels as
  local python3 processes (ignored in production); the tests use it.

- **Prompt:** `CODE_MODE_GUIDE` (in `python.ts`) follows the base prompt
  and says how its rules map onto run_python: a tool call becomes `await
  tools.<name>(...)`, one cell is one tool-use round, only printed output is
  seen, variables persist (so "read once" means keep it in a variable),
  ToolError and tracebacks, `ask_inputs` ends the turn, time limits, printing
  passages verbatim before citing them, a User-Agent for websites, and plain
  language to the user. Each turn also lists the names the conversation's
  kernel already holds.
- **Chat UI:** each cell is a `code_cell` event (`packages/contracts`),
  streamed when it starts and when it ends. The line reads "Computing", then
  "Computed · N steps · T s" (or "Computation stopped"); the steps it took are
  their own lines below it; opening it shows the code and the result. The
  owner asked for computing verbs over "Ran Python".

Not yet: dill and data packages on node-a (built and verified, see
`goals/STATUS.md`, queued request 5), `llm()` / `llm_batch()` for the RLM
path, an outbox for email, and the scenario eval the deep research describes.
Staging has no account linked to `ws-owner` (`/var/lib/mike-staging/workstation.env`
is absent; the one account, created 2026-10-10 by sign-up, is not the owner's
known email), so no staging user gets code mode until `mike-staging
owner-link` or an equivalent links the owner's account.

Receipts, 2026-10-10 (run from `backend/` unless noted):

```
$ npx vitest run src/lib/codemode src/modules/chat/engine/__tests__/streamingCodeMode.test.ts src/modules/chat/engine/__tests__/streamingInjectionFlags.test.ts src/lib/guardrails
 Test Files  7 passed (7)
      Tests  137 passed (137)
$ npm test            # whole backend suite
 Test Files  250 passed | 13 skipped (263)
      Tests  4454 passed | 100 skipped (4554)
```

Live, the Mac dev VM (QEMU in Docker, Python 3.14.7, no dill) through
`sshKernelLauncher` and `KernelManager`:

| step | time | result |
|---|---|---|
| first kernel start (install + ssh) | 12,820 ms | ready; a bare `ssh true` on this lane takes about 3 s |
| `sys.version`, `platform.machine()`, `os.getcwd()` | 62 ms | `3.14.7 aarch64 /home/agent` |
| one tool call | 101 ms | `{'echoed': 'over ssh'}` |
| 50 tool calls with `tools.gather` | 351 ms | `50 291 ms for 50 calls` |
| `import pandas` and a sum | 10,495 ms | `6` |
| `subprocess.run(['uname','-a'])` | 113 ms | `Linux workstation 6.18.55 ... aarch64` |
| `urllib.request.urlopen('https://www.sec.gov')` | 1,654 ms | `HTTP Error 403`: SEC requires a User-Agent |
| snapshot | | `No module named 'dill'`, logged once, then snapshots off |

Live on staging, 2026-10-10, from inside `mike-backend-1` (deployed
`a7e0a4be`) to `ws-owner` over vsock, with the ssh settings `staging.nix`
writes:

| step | time | result |
|---|---|---|
| kernel start (install + ssh over vsock) | 675 ms | Python 3.13.13 |
| `sys.version`, `platform.machine()`, `os.getcwd()` | 2 ms | `3.13.13 x86_64 /home/agent` |
| 50 tool calls with `tools.gather` | 7 ms | `50 6 ms for 50 calls` |
| `import pandas` and a sum | 798 ms | `6` |
| sec.gov `company_tickers.json` with a User-Agent | 509 ms | 799,583 bytes |
| snapshot | | `No module named 'dill'` (node-a is back on the image without it) |

### Receipts of the retired QuickJS slice, 2026-10-09

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
