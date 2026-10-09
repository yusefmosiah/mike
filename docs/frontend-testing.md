# Frontend unit-test coverage

The frontend has a Vitest (jsdom) unit-test harness. This doc tracks what is
covered, what still needs tests, and how the coverage ratchet works — the
frontend counterpart of [testing-coverage.md](testing-coverage.md), which does
the same for the backend. Pick up a checkbox below and land it as a small PR.

## Running the tests

```bash
cd frontend
npm install
npm test              # run all unit tests
npm run test:coverage # same, plus the per-file coverage table + floor check
```

TypeScript is pinned to 5.9.3 so ESLint can use the compiler API supported by
the installed TypeScript ESLint parser. When upgrading it, run `npm run lint`
and `npx tsc --noEmit` together to check parser and compiler compatibility.

Fortune-sheet is pinned because the spreadsheet viewer adjusts internal DOM
scroll extents. Upgrades must pass `SpreadsheetWorkbook.zoom.test.tsx` and
`SpreadsheetView.session.test.tsx`, followed by a browser check of zoom and
scrolling to the last row and column.

Tests live next to the code they test (`*.test.ts` / `*.test.tsx`). Read a
couple of the existing suites first (`src/app/lib/mikeApi.test.ts`,
`src/app/hooks/useAssistantChat.sse.test.ts`) and match their conventions:
mock `global fetch` — no network, no real
backend — one `describe` block per function or concern, and tests that assert
current behavior.

## Assistant streaming regressions

Changes to chat rendering, effect dependencies, scrolling or reveal animations
must exercise a long conversation and paced streaming, not just a completed
response. `e2e/assistant-streaming.spec.ts` loads eight synthetic exchanges and
sends four content replies or eight reasoning replies through a browser
`ReadableStream`, with CPU throttling. The reasoning case also expands,
collapses and resizes a live disclosure. Both cases run in the general assistant,
project assistant and tabular-review chat (six browser scenarios).
It uses the real Next.js/React renderer, fails on browser console errors and
uncaught exceptions, and requires no model-provider key. It belongs to the
Playwright `synthetic` project (specs that mock every `/api` call in the
browser), which CI runs as the **Assistant streaming (production, …)** jobs on
every PR, without the database/API stack. The **development** variants rerun it
on `next dev`, because React's passive-update-depth warning is
development-only; that job runs nightly, on manual dispatch, and on PRs
labelled `stress` (see [e2e-ci.md](e2e-ci.md#development-stress-jobs)). Add the
label to PRs that touch streaming or render loops.

Run it against the documented local stack with:

```bash
npm run test:e2e -- e2e/assistant-streaming.spec.ts
```

For a standalone frontend already running on localhost, its API fixtures and
empty storage state also allow a run without backend/auth setup:

```bash
CI=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:e2e -- \
  e2e/assistant-streaming.spec.ts --project=synthetic
```

For scroll state, observe the viewport and content size and respond to scroll
events. A changing `messages` array is not a layout signal: an effect that sets
scroll state on every chunk can exhaust React's passive-update limit, even when
the boolean is unchanged. Avoid dispatching equal values before calling the
setter; pending concurrent work can prevent React's eager bailout. The
`ChatView.actions.test.tsx` regressions check content reveal without a new message,
resize/scroll behavior, 120 consecutive chunks and observer/frame cleanup.

When investigating maximum-depth warnings, trace the repeated passive updates
as well as the final stack. The reveal animation can be the next setter that
crosses the limit, while a different component's effect caused the buildup.

## Review effects for update loops and starvation

Treat streamed text, message arrays, freshly allocated objects and callbacks as
high-frequency inputs. Before adding a state-setting effect, identify its actual
trigger and how it terminates:

- Derive display defaults from props during render. Keep state for user choices,
  rather than mirroring `isStreaming` on every chunk.
- Observe natural content size for overflow measurements. Coalesce observer
  callbacks into one animation frame and compare against the last published
  value **before** dispatching state. Observing a clipped wrapper can hide growth.
- Position/reveal a transcript when its chat, loading state or user-message count
  changes. Do not restart a timer or a two-frame layout operation on every text
  chunk: the callback can be starved indefinitely even without a console warning.
- Trace parent callbacks and external-store snapshots when objects change every
  render. Fix the source of instability; do not suppress exhaustive-deps or add
  arbitrary debounce delays to hide it.
- Keep an animation's elapsed time across new chunks and stop requesting frames
  when caught up. Test deltas arriving just before each frame, not only an idle
  clock after a single append.
- Reset user selections on navigation identity, not refreshed object identity.
  A row/document refetch should not close a pane or replace a chosen source.
- Retire asynchronous history requests on selection, new chat, deletion and
  unmount. Test reversed response order, including A → B → A: checking only the
  chat ID misses stale requests for the same chat.
- Test cleanup on close, unmount and Strict Mode remount. Test that work settles
  while geometry is unchanged, and that resize without a new message still works.

A functional setter returning its existing value is not sufficient evidence that
an effect is bounded under concurrent rendering. `useReasoningDisclosure.test.tsx`
checks 300 text updates, repeated resize notifications and cleanup. The assistant
and tabular chat suites interleave chunks with frame/timer advancement and assert
that history becomes visible **before** the stream ends. A buffered SSE fixture
or assertions only after `[DONE]` would miss those failures.

The Word add-in uses the same disclosure hook. Its
`word-addin/e2e/assistant-streaming.spec.ts` sends sixteen exchanges through paced
SSE in Chromium and WebKit, including a live resize to 320px and disclosure
interactions. Keep both production and development jobs required in branch
protection. Run the development check with no existing server on port 3100:

```bash
WORD_E2E_DEVELOPMENT=1 REACT_STRESS=1 npm run test:e2e --prefix word-addin -- \
  --retries=0
```

An existing local server is reused by Playwright, so make sure it serves the
intended build mode. Development bundles are static-served with the same Office
mock; the test does not need Word, HTTPS certificates or a real backend.

The complete web suite also runs on both production and development builds in
CI. `REACT_STRESS=1` applies 4x Chromium CPU throttling and fails UI fixtures on
maximum-depth, excessive-render, uncached-snapshot and ResizeObserver-loop
diagnostics. Word runs its complete hermetic suite in both build modes and both
engines; WebKit has no equivalent CDP CPU-throttling control. Existing error-path
tests may intentionally log other errors; the focused streaming/history tests
additionally fail on every console error and uncaught exception.
Stress mode disables retries and retains failed traces, so an intermittent loop
cannot become a passing check merely because a retry uses different timing.

`e2e/tabular-chat-lifecycle.spec.ts` switches sixteen times while history requests
are held, then releases long transcripts in reverse order. The latest selection
must remain visible before and after a narrow viewport resize.

See [the class audit](incidents/2026-09-29-streaming-effects-audit.md) for the
confirmed failures, unaffected paths examined and limits of the investigation.

## What the coverage gate covers

The ratchet gates `src/app/lib/**` only — the client library. Backend coverage has
a different scope: all `backend/src/**`. Components and hooks run in the same
frontend unit suite but are not coverage-floor-gated. The executable scope and
thresholds live in `frontend/vitest.config.mts`.

## Coverage evidence and regression priorities

The old August percentage table and unchecked "untested surfaces" PR list have
been removed. They are not a current coverage measurement or proof that a suite
is missing. Do not schedule work from an old checkbox or a config comment.

For a behavior change, inspect its current colocated suites and run the smallest
relevant regression. Use `npm run test:coverage --prefix frontend` when a current
measurement is needed; record the source revision, scope, command and output.
Coverage proves execution, not user-visible correctness.

Prioritize consumer-visible failures: permission/error handling, active-thread
selection after reload or out-of-order history, streaming/stop/resume transitions,
model availability, document/version resolution, and useful tool/citation rendering.
Add permanent tests for plausible behavioral regressions, not copied endpoint
arguments, prompt wording, component existence or implementation shape.

Real-app acceptance for the currently open branching, prompt-editing and local
voice outcomes is tracked in [the current agenda](../goals/STATUS.md) and
[whole-project accounting](../goals/TRIAGE.md). Passing unit tests does not close
the owner's reported missing controls.


## Ratchet policy

`frontend/vitest.config.mts` enforces global coverage **floors** over
`src/app/lib/**`: statements 100 / branches 99 / functions 100 / lines 100
(config inspected 2026-10-07, not a new measurement). Same rules as the backend
([testing-coverage.md](testing-coverage.md#ratchet-policy)):

- **Floors only go up.** Never lower them to get a PR green — that means your
  change removed tested behavior or added a large untested lib; add tests
  instead.
- **Raise them in the same PR that adds tests.** After your suite passes, run
  `npm run test:coverage`, take the new global numbers, and set each floor to
  the measured value rounded down to a whole percent.
- Keep measurements revision-bound. Update a threshold only with observed output;
  a documentation edit is not authority to lower the configured gate.
