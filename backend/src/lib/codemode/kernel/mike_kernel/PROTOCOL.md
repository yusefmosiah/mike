# Mike kernel protocol (version 1)

The harness starts `python3 -u -m mike_kernel` inside the employee's
workstation VM and speaks newline-delimited JSON over the process's stdin
(requests) and stdout (events). Each line is one UTF-8 JSON object. The
kernel's own diagnostics go to its stderr, which is not part of the protocol.

The design follows Prime Agent's `rlm.repl` protocol (version 3) and OMP's
Python runner; see `CREDITS.md`.

## Startup

The kernel's first line is:

```json
{"event": "ready", "protocol": 1, "python": "3.14.7", "pid": 1234, "started_at": 1791636438.6}
```

The harness then sends `configure` with the tool index, and `restore` if a
snapshot exists.

## Requests (harness → kernel)

| Request | Fields | Reply |
|---|---|---|
| `configure` | `id`, `tools`: list of `{name, description, parameters}` (JSON Schema) | `done` with `tools`: how many were bound |
| `execute` | `id`, `code` | stream events, then `done` with `status` `ok` or `error` |
| `interrupt` | `id` (optional; the cell to stop) | the running cell ends with a `KeyboardInterrupt` error |
| `host_reply` | `id` (of the `host_request`), `data` | none; the waiting tool call resumes |
| `snapshot` | `id`, `path`, optional `max_bytes`, `max_variable_bytes` | `done` with `saved`, `skipped`, `bytes` |
| `restore` | `id`, `path` | `done` with `restored`, `failed` (or `reason`) |
| `list_names` | `id` | `done` with `names` |
| `shutdown` | `id` (optional) | `done`, then the process exits |

Requests run one at a time in arrival order, except `interrupt` and
`host_reply`, which act immediately. An `interrupt` naming a cell that has not
started yet stops it as soon as it starts.

Closing stdin is an implicit `shutdown`. If the kernel has taken a snapshot
before, it writes one more to the same path first, so a harness restart keeps
the conversation's variables.

## Events (kernel → harness)

| Event | Fields | Meaning |
|---|---|---|
| `stdout`, `stderr` | `id` (the cell, or null), `text` | output, in chunks of at most 64 KiB |
| `result` | `id`, `text` | `repr()` of the cell's last expression, when it is not None |
| `display` | `id`, `data`: `{mime: value}` | sent by `emit({...})` in a cell |
| `host_request` | `id` (new), `cell`, `data` | the cell needs the harness; answer with `host_reply` |
| `error` | `id`, `ename`, `evalue`, `traceback` (list of lines) | the cell raised; `id` null for a protocol error |
| `done` | `id`, `status`, plus per-request fields | the request is finished |

Output written by a cell through Python (`print`) carries that cell's id, as
does output from asyncio tasks it started. Raw writes to file descriptors 1
and 2 (subprocesses, C extensions) carry the id of the cell running when the
bytes arrive. Everything a cell writes synchronously arrives before its
`done`.

## Host requests

The only `data.type` today is `tool`:

```json
{"event": "host_request", "id": "9f…", "cell": "c1", "data": {"type": "tool", "name": "read_document", "args": {"doc_id": "…"}}}
```

The harness answers with one of:

```json
{"type": "host_reply", "id": "9f…", "data": {"ok": true, "content": "<the tool's result text>"}}
{"type": "host_reply", "id": "9f…", "data": {"ok": false, "error": "why"}}
{"type": "host_reply", "id": "9f…", "data": {"paused": true, "message": "Waiting for the user's answer."}}
```

In the cell, `content` that parses as JSON is returned parsed. A result that
is a JSON object with an `error` string, or `ok: false`, raises `ToolError`.
`paused` raises `UserQuestionPending`, a `BaseException`, so the cell ends and
the turn waits for the user.

## The cell namespace

`configure` binds:

- `tools`: each tool as `await tools.<name>(...)`, with keyword or positional
  arguments (required parameters first) or a single dict. `help(tools.<name>)`
  shows its parameters; `tools.search("words")` lists matching tools;
  `await tools.gather(...)` runs several calls at once.
- `ToolError`, `UserQuestionPending`.
- `emit(data)`: send a `display` event.

Cells may use top-level `await`. A cell whose last expression is an
un-awaited tool call has it awaited. A tool call that is never awaited does
not run, and the cell's stderr says so.

`input()` reads end-of-file. `SystemExit` and `KeyboardInterrupt` end only the
cell.

## Snapshots

`snapshot` writes the namespace to `path` atomically: modules by name, other
values with dill one at a time. A value that cannot be pickled (an open
socket, a coroutine) is listed in `skipped` and the rest are kept. Without
dill installed, `snapshot` and `restore` fail with a `reason` and the kernel
works otherwise. Snapshots are written and read only inside the VM.
