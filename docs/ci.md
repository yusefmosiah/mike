# CI

What runs, when, what it blocks, and what to do when it is red.

## The short version

- Before pushing to `main`, run `npm run verify` from the repository root. It
  runs what the gating `CI` workflow runs, quick checks first, and stops at
  the first failure. On a machine shared with other work, add
  `-- --workers 2`.
- A push to `main` runs `CI`. A green `CI` deploys that commit to staging; a
  red one does not (the deploy shows as `skipped`).
- Everything else either runs on a schedule or only when its own files
  change, and reports to a standing GitHub issue instead of blocking anyone.

Workflow names, schedules, job lists and coverage thresholds here are as of
2026-10-27; re-read `.github/workflows/` and `backend/vitest.config.mts` before
relying on them.

## What gates the deploy

`.github/workflows/ci.yml`. Its jobs run side by side:

| Job | Commands | Local equivalent |
|---|---|---|
| Backend types and build | `typecheck:test`, `typecheck:contracts`, `build` (in `backend/`) | `npm run verify -- backend` |
| Backend tests | `test:coverage` (core tests, coverage floors) | same |
| Frontend types and lint | `typecheck`, `lint` (in `frontend/`) | `npm run verify -- frontend` |
| Frontend tests | `test:coverage` (core tests, coverage floors) | same |
| Frontend build | `build`, `catalog:build` | same |
| Browser spec types | `npm run typecheck:e2e` (root): the Playwright specs, which run only nightly | `npm run verify` |
| Docker images | builds the frontend, backend and add-in images (`docker-images.yml`) | `npm run verify -- --full` |

The repository ruleset "main: CI must pass" requires these jobs, by name, on
pull requests into `main` (admins push directly). Renaming or adding a job
here means updating the ruleset too, or a pull request waits forever on a
check that never reports:
`gh api repos/yusefmosiah/mike/rulesets` lists it, and a `PUT` to its id
replaces `required_status_checks`.

Pushes that change only documentation (`docs/**`, `*.md`) skip `CI` and
therefore do not deploy; the next code change deploys them.

The backend suite also runs the docs audit
(`backend/src/__tests__/docsAudit.test.ts`): a route mounted in `app.ts`, a
module directory, or a code-mode tool must have a page in
`docs/capabilities-map.json` or a reasoned entry in
`docs/capabilities-allowlist.json`. A stale map or allowlist entry fails too,
so a removed capability cannot keep its page alive.

`.github/workflows/deploy-staging.yml` runs when `CI` completes on `main` and
deploys only a green run.

## What does not gate the deploy

| Workflow | When | Reports to |
|---|---|---|
| `nightly.yml`: the Word add-in, the browser end-to-end suite, Google Workspace database checks, the dormant features' unit tests | 03:17 UTC daily, or by hand | issue labelled `nightly` |
| `security.yml`: dependency advisories | 05:41 UTC daily, and on any `package.json` or lockfile change | issue labelled `security` (scheduled runs) |
| `codeql.yml` | weekly, Monday | the Security tab |
| `scorecard.yml` | weekly, Monday | the Security tab |
| `stack-tests.yml` | backend, `packages/` or `docker-compose.yml` changes | the run itself |
| `schema-drift.yml` | `backend/schema.sql`, migrations or `backend/scripts/` changes | the run itself |
| `word-addin.yml` | `word-addin/` changes, and nightly | the run itself / `nightly` |
| `e2e.yml` | pull requests, and nightly | the run itself / `nightly` |
| `gitleaks.yml` | every push | the run itself |
| `computer-helpers.yml`: the Rust computer helpers on Linux and Windows, and the sandbox desktop image driven end to end | `computer-helper-rs/` or the shared protocol fixtures change | the run itself |

A scheduled failure opens one issue with its label, comments on it on later
failures, and closes it when a run is green again
(`scripts/ci/report-scheduled-run.sh`). Check those issues when you start a
session; they are the only place a nightly failure appears.

## Dormant features

Inherited features not in active use: **tabular reviews**, **Google
Workspace connections** and the **Word add-in**. Their tests do not gate the
deploy; they run nightly, and fixing them waits until work on the feature
resumes. A change to shared code that breaks one of them shows up in the
`nightly` issue the next morning.

The lists live in `backend/vitest.groups.mts` and
`frontend/vitest.groups.mts` (the test files, and the source files that leave
the gated coverage measurement with them). `MIKE_TEST_GROUP` picks a group:
unset or `core` (what CI runs), `dormant` (`npm run test:dormant`), or `all`.

To make a feature gate again: delete its entries from both lists, restore its
coverage (the floors then include its sources), and for the Word add-in, add
its job back to `ci.yml` or widen `word-addin.yml`'s push paths.

## Watching CI and the staging deploy

Use the authenticated `gh` CLI, never unauthenticated `curl` against the
GitHub API, which allows 60 requests an hour and fails partway through a
poll loop:

```bash
sha=$(git rev-parse HEAD)
gh run list --commit "$sha" --json name,status,conclusion,databaseId
gh run watch "$(gh run list --commit "$sha" --workflow CI --json databaseId --jq '.[0].databaseId')" --exit-status
gh run list --commit "$sha" --workflow "Deploy staging" --json status,conclusion
```

A run appears a few seconds after the push, and `Deploy staging` only after
`CI` completes. A `skipped` deploy means `CI` did not pass; it is not a
deploy failure.

## Diagnosing a red run

1. `gh run view <run id> --log-failed` shows the failing step's output.
   Search it for ` FAIL `, `ERROR: Coverage` and `error TS`.
2. Reproduce with the job's command from the table above, in that package.
   For a test, run the one file: `npm test --prefix frontend -- <path>`.
3. A coverage failure (`ERROR: Coverage for statements (99.98%) does not meet
   global threshold (100%)`) happens after every test passed. The text table
   above it names the file and the uncovered lines.
4. Playwright failures upload an HTML report and traces as run artifacts:
   `gh run download <run id>` (see `docs/e2e-ci.md`).

## Flaky tests

A test that fails and then passes on a rerun has a bug, in the test or the
code. Fix the cause; do not add retries or raise a timeout to make it pass.
The usual causes, and what the suites now do about them:

- **Waiting too briefly.** Frontend `findBy*` and `waitFor` wait up to 5 s
  (`frontend/vitest.setup.ts`), not the library's 1 s.
- **Asserting before an effect runs.** Wait for the outcome (`await
  waitFor(...)`), not for a proxy such as focus. If an action is lost when it
  happens before a listener attaches, repeat the action inside the `waitFor`
  (see `ChatView.panelGestures.test.tsx`).
- **Timing the code.** Don't assert that something took less than N ms in an
  ordinary test; it fails whenever the machine is busy. Prove the behaviour
  instead (count concurrent calls, let the test's own time limit catch a
  hang), and put real speed budgets behind `expectWithinBudget`
  (`backend/src/__tests__/helpers/perfBudget.ts`), checked by
  `npm run test:perf --prefix backend`.
- **Leaking state between tests.** Spies, stubbed globals and stubbed env
  vars are undone after every test (`restoreMocks`, `unstubGlobals`,
  `unstubEnvs` in `frontend/vitest.config.mts`). Stub in `beforeEach`, not
  `beforeAll`, and give each `describe` the setup it needs.
- **A negative assertion that passes too early.** `expect(queryBy...).not
  .toBeInTheDocument()` passes before anything renders; first wait for
  something that proves the render happened.

Frontend test files run in a fresh VM context inside a reused worker thread
(the `unit` project in `frontend/vitest.config.mts`), which is about five
times faster than a process per file. A file that redefines `window`,
`document` or `location`, or loads native tooling, fails there with "Cannot
redefine property" or a module-hook error; add it to `VM_UNSAFE_TESTS` in
that config so it gets its own process.

Playwright retries failed tests twice on CI (`playwright.config.ts`); a test
listed as `flaky` in the report passed only on a retry and needs the same
fix.

## Coverage

- Frontend: `src/app/lib/**` must stay at 100% statements, functions and
  lines and 99% branches. Code that genuinely cannot be tested may be marked,
  with the reason, instead of gaining a test written only to touch it:
  `/* v8 ignore next -- <why> */` before a statement, or
  `/* v8 ignore else -- <why> */` before an `if` whose `else` cannot be
  reached.
- Backend: all of `src/` (less the dormant sources), with floors just under
  the measured numbers so a real drop fails. Raise them when coverage rises.

## Which checks for which change

`npm run verify` covers every gating check. These run separately:

| You changed | Also run |
|---|---|
| `backend/schema.sql` or `backend/migrations/` | `npm run test:stack --prefix backend`; the `schema-drift` workflow runs on push |
| A `Dockerfile`, `.dockerignore`, tsconfig, or a cross-package import | `npm run verify -- --full` |
| `word-addin/` | `npm run typecheck --prefix word-addin` and `npm run test:e2e --prefix word-addin` |
| A dormant feature | `npm run test:dormant --prefix backend` and `--prefix frontend` |
| A browser flow | the relevant Playwright spec: `npm run test:e2e -- e2e/<spec>` (`docs/frontend-testing.md`) |
