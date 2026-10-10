# Code mode: language, runtime and sandbox (research, 2026-10-10)

The owner asked for a research pass before more code-mode work. The goal is a
dual experience we can evaluate: **with code mode**, the model reaches every
tool through code; **without**, it calls the tools directly as today. The
owner's constraint: code mode is for *more* power, so a sandbox with no network
(QuickJS, V8 isolates) misses the point. Safety and recovery come from the
microVM, and possibly containers (Mission 13).

Nothing here is built yet. Sources are listed at the end; figures marked
"vendor" come from the people selling the approach.

## Owner decisions, 2026-10-10 (after the first draft)

- Model quality is not a concern: every model we will use writes Python well.
  The per-model accuracy evidence below is background, not a gate.
- Every user has a VM. Firms are small boutiques, so all of a firm's VMs fit on
  one machine. On staging the harness and the VMs share node-a; production may
  split them across two machines.
- `ask_inputs` and the Word add-in's tools should also be callable from Python,
  so code mode reaches every tool.
- For the eval, both modes run at once on each message: one visible, one a
  shadow, with both logged for comparison.
- User data must survive a corrupted VM. Open: whether btrfs rollback is
  enough, or recovery needs an app or middleware layer too.

## Revised design after OMP and Prime Agent (2026-10-10)

Two MIT-licensed agents that run models in a persistent CPython process both
dropped Jupyter in favour of a small JSON-lines runner:

- **OMP (oh-my-pi, can1357/oh-my-pi).** Shipped an IPython tool on the Jupyter
  kernel gateway over WebSocket in January 2026 (`1d414c13`). In May it replaced
  it with `python -u runner.py` speaking NDJSON over stdin/stdout, deleting the
  gateway, its coordinator and the `jupyter` commands (`8d144e17`).
  - `runner.py` is about 2,500 lines and the prelude about 1,100.
  - Cells get top-level `await`; magics are rewritten to plain Python.
  - An interrupt is SIGINT, and the kernel survives it; a kill follows if the
    cell is stuck in C for 5 s.
  - The cell timeout pauses while waiting on subagents or `%pip`.
  - Tools come back to the agent over a loopback HTTP bridge with a per-session
    token.
- **Prime Agent (PrimeIntellect-ai/prime-agent, rewritten in Rust,
  announced 2026-10-09).** "A persistent Python REPL is the built-in model
  tool": files, shell, tools and subagents all go through code (their RLM:
  context as variables, tools and subagents as function calls).
  - The kernel is `python -m rlm.repl`, protocol version 3 (`repl.md`): JSON-lines
    requests on stdin and events on a private copy of stdout.
  - Each cell is attributed its own output, raw file-descriptor output is fenced
    before `done`, and interrupt delivery is task-aware.
  - **Tool calls ride the same channel:** the cell awaits `host_request(...)`,
    and the host answers with `host_reply`.
  - **`snapshot`/`restore`** serialise the user namespace with `dill`, name by
    name, with size caps.
  - Its README says the kernel "is not a security sandbox" and should run inside
    one.

What changes in our design:

- **Kernel:** adopt Prime Agent's protocol and adapt its runtime (or OMP's)
  instead of IPython, crediting it in CREDITS.md. It needs no server, ports,
  ZeroMQ or token in the VM.
- **Tool bridge:** `host_request`/`host_reply` on the kernel's own channel
  replaces the separate vsock capability port. The VM gets no URL or token; the
  only way to Mike's tools is the session the harness holds, and each request
  goes through the one dispatcher.
- **Keeping the kernel alive:** the kernel runs under a small supervisor in the
  VM that the harness reaches over vsock. A backend restart then does not kill
  the kernel, and pending host requests are re-delivered when the harness
  reconnects.
- **Kernel state:** `dill` snapshots sit next to the per-turn btrfs snapshot, so
  a restored VM or a shadow run starts with the same variables.
- **`ask_inputs` and the Word tools:** host requests like any other. The cell
  timeout pauses while a request waits on the user. A Word call round-trips to
  the add-in, so code should batch.

## Where we are

- **Mission 11's first slice** runs `run_script` in QuickJS inside the backend
  process. It has `tools.*` and `console`, but no network, filesystem, timers or
  libraries. In the live probe the model chose it unprompted for ten parallel
  web searches. That sandbox is the one the owner has now ruled out as the
  main path.
- **Mission 13** gives each employee a Cloud Hypervisor VM (`ws-owner` on
  node-a) with Python 3.14, python-docx, openpyxl, Node 22 and git:
  - commands reach it through `run_command` over vsock;
  - egress goes through a logging proxy that blocks private ranges;
  - the harness takes a btrfs snapshot before each command-running turn, and an
    `rm -rf ~/*` was fully restored.
  - The VM cannot yet call Mike's own tools. That "capability socket" is listed
    as phase 6.
- **Chat tools:** 19 built-in tools, plus connector (MCP), CourtListener, Gmail
  and Drive tools when enabled.

## What the evidence says

**Code mode helps on the right tasks, and the gain depends on the model.**

- *The Bitter Lesson of Tool Calling* (arXiv 2608.06370) compared Python "programmatic
  tool calling" (PTC) with JSON tool calls on 309 BFCL v4 tasks across 14 models:
  - 11 of 14 models matched or beat JSON. Claude Sonnet 4.6 went from 80.9 to
    87.4, and GPT-5.6-Terra from 73.5 to 84.1.
  - Three older or small OpenAI models collapsed: GPT-4o 81.9 → 55.0, GPT-5.4-mini
    79.3 → 55.0, GPT-4.1 81.9 → 62.1. The cause was mechanical: they wrote literal
    `\n` escapes instead of newlines inside the code string, so the script failed
    to parse.
  - Code won where it should. On long chains (≥12 calls) it was 18.8 points
    ahead. On fan-out, JSON fell apart past about 70 parallel calls (Claude Sonnet 5:
    0% at N=100) while code stayed at 100%. With 128 decoy schemas in context, JSON
    lost 2.3 points on average and code gained 5.5.
  - Costs: about 1.5× the input tokens on chaining tasks, stubs that echo
    instead of calling real APIs, and small ablations (±8 to 17 points at 95%).
- **Anthropic's programmatic tool calling** is now GA:
  - the model writes Python in a code-execution container;
  - each tool is an async Python function (run in parallel with `asyncio.gather`);
  - execution pauses at each tool call and resumes with the client's result;
  - the container keeps state across calls for up to 30 days.
  - On BrowseComp and DeepSearchQA it improved accuracy by 11% on average with
    24% fewer input tokens. Anthropic's own docs state that `allowed_callers` is
    not a security boundary.
- **Anthropic, "Code execution with MCP"** argues for tools presented as code
  files the agent reads on demand, filtering large results in code, and keeping
  intermediate data out of the model's context. Its example workflow dropped from
  150,000 to 2,000 tokens (vendor). It names the cost plainly: a real sandbox,
  resource limits and monitoring.
- **Cloudflare's Code Mode** (TypeScript in V8 isolates) blocks the internet on
  purpose: only bindings to MCP servers get through, because "filtering is hard
  on both the LLM and the supervisor". The design depends on that sandbox, and it
  gives no benchmark numbers. It is the opposite trade to the one the owner wants.
- **CodeAct** (ICLR 2024; smolagents' `CodeAgent`) reported up to 20% higher
  success on multi-tool tasks with fewer turns, on 2024 models.

**Taken together:** code mode pays off for fan-out, long chains, large tool
catalogs and large intermediate data. It is neutral or slightly costly for one
or two calls. For some models it fails for mechanical reasons, which is exactly
what a per-model eval catches.

## Choice of language: Python

| | Python (CPython in the VM) | TypeScript / JavaScript (Node or Deno in the VM) |
|---|---|---|
| Production precedent with network and state | Anthropic PTC, OpenHands (IPython in a container), CodeAct, smolagents | Cloudflare and TanStack, both in no-network isolates |
| Libraries for our work | python-docx, openpyxl, pandas, pdfplumber, requests, already in the guest image | docx and xlsx libraries are weaker; data work is clumsier |
| Model fluency | Strongest language in every multilingual benchmark found (Multi-LCB: Python overfitting; SWE-PolyBench: Python 20–24% vs TypeScript 5–13%) | Good, and the static types catch errors before running |
| Parallel tool calls | `await asyncio.gather(...)` | `await Promise.all(...)` |
| Stateful REPL | IPython kernel: top-level `await`, variables persist, a mature protocol | Node REPL or a Deno kernel: workable, less proven |

**Recommendation: Python, CPython 3.14 in the employee's VM, as a stateful
IPython kernel per conversation.** It has the network (through the proxy), the
libraries, the filesystem, and variables that survive between cells, as in
Anthropic's container and ChatGPT's data analysis. Node stays available in the
VM through `run_command`, but not as the code-mode language. Two languages
would double the stubs, the prompts and the eval for no measured gain.

Rejected:
- **QuickJS** (our first slice) and **V8 isolates**: no network or libraries, by
  design.
- **Pyodide in Deno**: a WebAssembly Python with a smaller library set, and
  pointless inside a VM that already isolates.
- **Pydantic's Monty**: a Rust Python subset with microsecond start and no
  network or filesystem unless granted. It is labelled experimental and lacks
  `re`, `datetime` and `json`. Right for a different trade (cheap, no VM);
  not ours.

## Runtime design

```text
model ──run_python(code)──▶ Mike backend (harness)
                              │ ssh over vsock: send the cell to the conversation's kernel
                              ▼
               employee VM ── IPython kernel (CPython 3.14, python-docx, pandas, ...)
                 │  from mike import tools
                 │  await tools.read_document(document_id=...)   ──┐
                 │  requests.get("https://...")  → egress proxy     │ vsock capability port
                 ▼                                                  ▼
               files in /home (btrfs snapshot per turn)   backend: same dispatcher, Auto Mode
                                                           checks, audit and turn events as a
                                                           direct call, as that user, in that turn
```

- **One code tool.** The model writes Python in `run_python`; the kernel runs it.
  Printed output (truncated), plus any files it writes, come back to the model.
- **Mike's tools inside Python.** A generated `mike` package: one typed async
  function per tool, built from `toolSchemas.ts`, with docstrings from the tool
  descriptions and results returned as parsed JSON. Discovery uses
  `help(tools.x)` and `tools.search("...")`, following Pi's `searchTools` and
  Anthropic's on-demand reading, so the prompt does not carry every signature.
- **Capability socket.** Calls leave the VM on a vsock port. A host relay hands
  them to the backend with a per-run capability: bound to that VM's user, that
  conversation and that turn, and valid only while the cell runs. The VM holds
  no token. An injected script can do no more than the user could in that turn,
  through the same dispatcher, gates and audit trail. This is Mission 13's phase
  6, pulled forward.
- **Network.** On, through the existing proxy: private ranges blocked, every host
  logged. Code can call the web directly or use Mike's `web_search` and
  `fetch_web_page`.
- **Recovery.**
  - Files in the VM: the per-turn btrfs snapshot, as built.
  - Firm records: changed only through Mike tools, so they get document versions.
  - Kernel memory: not snapshotted. After a restore, the kernel restarts.
- **Containers (optional, later).** Inside the VM, each cell could run in a
  bubblewrap "capsule" with an overlay that commits only when the cell succeeds,
  like Pi's `store`/`load` (go-choir capsules, oops-sh). It is not needed for
  the eval. A container on the host is not a substitute: the microVM is the
  boundary.
- **The literal-`\n` failure.** The worst losses in the Bitter Lesson study came
  from code written as an escaped JSON string. If a submitted cell contains no
  real newlines but does contain `\n`, the harness unescapes it before running
  and notes this in the result. Accepting code in a fenced block in the reply is
  a fallback to test.

## The two modes, for evaluation

| | Without code mode (direct) | With code mode |
|---|---|---|
| Model sees | the tools, as today | `run_python`, plus a short tool index |
| Tool calls | JSON, one model step per batch | inside Python, any number per step |
| Stays direct in both | `ask_inputs` (needs the user), the Word add-in's client-side tools | same |
| Where it runs | backend | the employee's VM |

The mode is a per-conversation setting (and an eval flag), not a global
environment variable. A user without a VM gets direct mode. Whether to give them
a pooled VM is open below.

## Evaluation plan

- **Tasks.** About 40 Mike tasks, each with a scripted checker, as MCPMark and
  MCP-Universe do, rather than an LLM judge alone:
  - **Fan-out:** a clause across 20 documents; 10 web searches ranked.
  - **Chains:** read, extract, generate a .docx, verify it.
  - **Tabular extraction.**
  - **Spreadsheet analysis:** the 500-row `sales.csv`.
  - **Citation check** of a memo.
  - **One- or two-call tasks**, to measure the overhead.
  - **Safety:** an injected instruction in a document, and a destructive request
    followed by a restore.
- **Arms × models.** Direct vs code, on DeepSeek V4.1 Flash, GLM-5.3-Flash and
  Muse Spark 1.3 Contributor (OpenCode Go allowances), plus one premium model
  for contrast. Three runs per task, arm and model.
- **Measures:**
  - task success;
  - input and output tokens;
  - model calls and wall time;
  - tool calls;
  - script errors (syntax, the `\n` case);
  - money;
  - safety outcomes.
  - Report paired per-task differences with 95% intervals.
- **Harness.** A backend script drives real chat turns through the API with the
  mode flag, captures each turn's events and token usage, and runs the checkers.
  It uses fresh localhost accounts and the dev or node-a VM.

## Proposed order of work

1. Python `mike` package and capability socket (vsock relay, per-run capability),
   with unit tests and a live call from the dev VM back to the local backend.
2. `run_python` on a per-conversation IPython kernel, including output limits,
   timeouts, interrupt, restart and the `\n` repair.
3. Mode switch and "code only" exposure; QuickJS `run_script` retired behind it.
4. Eval task set, checkers and harness; first run on the three flash models.
5. Report to the owner; pick defaults per model.

## Open questions for the owner

1. **Users without a VM:** direct mode only, or a pool of short-lived VMs for
   code mode?
2. **Exfiltration.** With network and documents in the same Python process, an
   injected instruction could post document text to a website. The proxy logs
   the host, but without TLS interception (Mission 13's open question) it cannot
   see contents. Options:
   - accept and log;
   - an allowlist of sites in code mode;
   - replace personal data with tokens before the model sees it, as Anthropic
     describes.
3. **Premium contrast model** for the eval, and a budget for it.

## Sources

- [The Bitter Lesson of Tool Calling (arXiv 2608.06370)](https://arxiv.org/html/2608.06370v1)
- [Anthropic: Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode/)
- [Executable Code Actions Elicit Better LLM Agents (CodeAct, ICLR 2024)](https://www.iclr.cc/virtual/2024/22224)
- [SkillCraft (arXiv 2603.00718)](https://arxiv.org/abs/2603.00718)
- [Pi code mode docs](https://pi.dev/docs/latest/codemode)
- [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi): `docs/python-repl.md`, `packages/coding-agent/src/eval/py/runner.py`
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): `prime-agent-runtime/src/rlm/repl.md`; [Rewriting Prime Agent in Rust](https://www.primeintellect.ai/blog/prime-agent-rust)
- [Pydantic Monty](https://pydantic.dev/articles/pydantic-monty)
- [OpenHands runtime architecture](https://docs.openhands.dev/usage/architecture/runtime)
- [Multi-LCB (multilingual LiveCodeBench)](https://www.emergentmind.com/papers/2606.20517); [SWE-PolyBench](https://alphaxiv.org/benchmarks/aws-ai-labs/swe-polybench)
- [Firecracker vs Cloud Hypervisor (Northflank)](https://northflank.com/blog/firecracker-vs-cloud-hypervisor)
- [Agent sandboxes compared: E2B, Daytona, Modal, Vercel](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/daytona-vs-e2b-vs-modal-vs-vercel-sandbox-2026)
- [Sandlock (arXiv 2605.26298)](https://arxiv.org/pdf/2605.26298); [DeltaBox (arXiv 2605.22781)](https://arxiv.org/pdf/2605.22781); [oops-sh](https://docs.rs/crate/oops-sh/0.2.0)
- [MCPMark (ICLR 2026)](https://iclr.cc/virtual/2026/poster/10006866); [MCP-Universe](https://www.salesforce.com/blog/mcp-universe/); [MCP-Atlas](https://arxiv.org/html/2602.00933v1)
