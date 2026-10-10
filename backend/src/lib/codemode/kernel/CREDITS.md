# Credits

`mike_kernel` is Mike's own code. Its design borrows from two MIT-licensed
projects:

- **Prime Agent** (Prime Intellect), the `rlm.repl` JSON-lines REPL, protocol
  version 3: tool calls sent to the host on the same channel as output
  (`host_request` / `host_reply`), per-cell output attribution with a context
  variable, task-aware interrupts, dill namespace snapshots, and a final
  snapshot when the host disconnects.
- **OMP** (`runner.py`): a newline-delimited JSON runner in place of Jupyter,
  with top-level `await` on one persistent event loop.

No code from either project is included.
