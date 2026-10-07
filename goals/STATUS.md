# Private Deployment: Status and Agenda

Audited 2026-10-07, after an unattended overnight run that marked every
station of `goals/private-firm-deployment-spine.md` complete. It wasn't. This
file is the source of truth for state and order of work; where a station file
disagrees, this file wins.

## How the overnight run went wrong

- Acceptance tests were written to match the code rather than the goal. They
  pass (backend suite: 3,033 tests, 0 failures) while the goals fail.
- Several "deployed" receipts cite `curl -f http://localhost:3000/health`.
  `/health` is served by the backend on 3001; the frontend has no such route.
  Those checks were never run. The receipts have been removed.
- About ten acceptance-test paths in the station files name files that were
  never written (for example `chat.diff.test.ts`, `packages/mike-sdk`).
- `docs/reports/mike-private-build-2026-10-07.md` repeats the overstated claims.

## Station state

| # | Station | State | What is actually there |
|---|---|---|---|
| 1 | Document AST and block tools | needs rework | `replace_block` and `delete_blocks` flatten a paragraph to plain text: bold, footnote references, hyperlinks and fields are lost, and rejecting the change does not restore them. Block IDs are positions, so an `insert_block` earlier in a batch shifts later targets (a probe replaced the wrong paragraph after its precondition passed). `replace_block` on a table writes invalid OOXML. Range deletes skip tables. `delete_empty_blocks` deletes untracked. Tests use only tiny synthetic documents. |
| 2 | `get_diff` and linter | needs rework | The linter runs inside `get_diff`, after the version is already live; it never gates activation. No integration test of the self-review loop. |
| 3 | Search and citations | partial | Four search adapters and `fetchPage` work. Citation checking is substring matching only; snapshots live in a process-wide in-memory map (unbounded, lost on restart). `fetchPage` follows redirects and checks DNS before, not at, connect time. Search API calls have no strict-mode gate. |
| 4 | Context resilience and compaction | partial | JSON repair and paginated `read_document` are real. Compaction is never called from the chat engine. The Snapcompact font is ASCII-only (`§`, curly quotes and dashes render as `?`). |
| 5 | Tree branching | unverified | Migration, server context builder, UI and tests exist. Not yet checked end to end in a browser. |
| 6 | Local audio | unverified | Backend proxies and frontend hooks exist. Never run against a real STT/TTS endpoint. |
| 7 | Auto Mode | partial | Three tiers and a classifier that denies on failure. Tier 1 auto-approved `web_search`, `fetch_web_page` and `execute_code` (fixed in Mission 0). No OpenRouter classifier lane. |
| 8 | Private mode and Phala | tabled | "Attestation" fetches JSON and string-compares `measurement`: no quote verification, signature, nonce or TLS binding. Strict mode does not gate search providers, CourtListener, Google Workspace, MCP, the GitHub workflow catalog, or frontend Sentry. No `inference_receipts` table. |
| 9 | Code execution and RLM | tabled | The `node:vm` sandbox exposed the host `process` (env secrets) to model-written code (removed in Mission 0). The "RLM" is a wave-based excerpt skimmer capped at 500 documents; no subagents, SDK, worker container or schedule. |
| 10 | Mobile and OCR | tabled | Mobile is a Capacitor config plus a README. OCR stops after 10 pages per document. The hybrid-retrieval module has no callers and nothing writes `document_chunks`; there is no pgvector. |

## Agenda

One mission at a time. A mission is done only when the owner accepts it.

0. **Honest baseline** (this change)
   - Disable `execute_code` everywhere: the tool is no longer advertised or
     dispatched, and `lib/sandbox/executeCode` refuses all input.
   - Move `web_search` and `fetch_web_page` out of Auto Mode Tier 1.
   - Unmount `/diligence` (RLM deep runs).
   - Correct the spine and station statuses; remove unrun receipts; write
     this file.
1. **Word document handling and the tool/prompt surface**
   - Run-level edits that keep formatting, footnote references, hyperlinks
     and fields; reversible in Word.
   - Block IDs that stay stable within a batch; true all-or-nothing batches.
   - Table cells as edit targets; tracked empty-paragraph removal.
   - Linter gates version activation.
   - Redesign tools and system prompt together so each kind of edit has one
     clear path.
   - Acceptance: real human-authored `.docx` fixtures (13+ pages, tables,
     footnotes, mixed formatting, existing tracked changes). Untouched parts
     unchanged; accept-all and reject-all in Word give the right documents.
2. **Compaction that triggers**
   - Wire the policy into the streaming loop: post-turn, at tool-loop
     boundaries, and on overflow recovery.
   - Acceptance: a test that drives a conversation past the threshold and
     shows it fire, plus one live OpenCode Go session.
3. **Branching, prompt editing, branch threads, and audio, end to end**
   - Acceptance: Playwright runs of each flow in the real app.
4. **Auto Mode classifier on OpenRouter (Jev)**

Later, in order:

- Citation checking by subagents that read the actual source (needs subagent
  infrastructure first).
- Phala inference and private mode, in preparation for local models.
- RLM diligence, mobile app, OCR.

## Acceptance rules

- A station or mission is complete only with: the acceptance command's real
  output, a probe that exercises the feature the way a user would, and the
  owner's sign-off. An agent may not mark its own work complete.
- An acceptance check must run the feature on real input; a test that only
  shows a function exists or returns the shape it was written to return does
  not count.
- Receipts quote what was run and what it printed. A command that was not run
  is not a receipt.
