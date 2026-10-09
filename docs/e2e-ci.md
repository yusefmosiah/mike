# End-to-end tests in CI

The Playwright suite (`e2e/`) runs on every pull request through
`.github/workflows/e2e.yml`. This document covers the one repository secret it
needs and the **branch-protection step that turns a red run into a blocked
merge** — the workflow reports pass/fail on its own, but only branch protection
makes that check *required*.

## What the workflow does

On every `pull_request`, including stacked PRs targeting another feature branch,
on manual `workflow_dispatch`, and **nightly at 03:47 UTC** (a `schedule` cron,
so drift that lands between PRs — dependency bumps, image changes,
selector-breaking UI tweaks — is caught within a day), the `e2e / playwright`
matrix:

1. installs the root (Playwright), `backend/`, and `frontend/` dependencies;
2. boots **RustFS** (S3-compatible object storage — several specs upload documents);
3. boots **Postgres and GoTrue** from `docker-compose.yml` and loads the
   current fresh-install shape from `backend/schema.sql`. It intentionally does
   not replay historical migrations on top: doing so can replace current
   functions with older definitions. The separate schema-drift workflow proves
   that the supported upgrade path (its pinned baseline plus later migrations)
   converges with this fresh-install path;
4. writes `backend/.env` (`AUTH_URL`, `AUTH_SERVICE_KEY`, `DATABASE_URL`) and
   `frontend/.env.local` for those services;
5. builds the backend and runs the pinned `sync:workflows` release job, matching
   production ordering so the default and add-on catalog exists before startup;
6. serves the production build (`next build` / `next start`) in one job and
   the development renderer (`next dev`) in another. The development job warms
   static routes, sets `REACT_STRESS=1` for 4x Chromium CPU pressure, and fails
   on React/observer loop diagnostics. Development overlays remain observable;
   they are not suppressed to make selectors pass. Both jobs use the backend
   API (`:3001`) and web server (`:3000`) with isolated disposable services;
7. runs `npx playwright test --project=chromium` on three parallel workers and
   uploads the HTML report + traces as an artifact (`playwright-report-production` /
   `playwright-report-development`) on pass, fail, or timeout.

### Test users and parallel workers

Each Playwright worker signs in as its **own** user, following Playwright's
[one account per parallel worker](https://playwright.dev/docs/auth#moderate-one-account-per-parallel-worker)
pattern. Worker 0 is the historical `e2e@mike.local` (or `E2E_EMAIL` /
`E2E_PASSWORD`); worker *n* is `e2e-wn@mike.local` with the same password
(`workerAccount()` in `e2e/users.ts`). The worker-scoped fixture in
`e2e/fixtures.ts` creates the account through the local GoTrue admin API,
signs in once, finishes onboarding and reuses the session for every test in
that worker. Separate users have separate project, chat and workflow lists and
separate sessions, so workers can't race on each other's data. Tests inside a
file still run in order. `e2e/auth.setup.ts` only creates the dedicated logout
user, whose global sign-out must never revoke a shared session. No login secret
is needed.

`E2E_WORKERS` sets the worker count (CI sets 3; the default is 1, because
`next dev` compiles routes on demand). A spec that needs a specific user's
details takes the `e2eAccount` fixture instead of hardcoding an email.

### Synthetic specs

`e2e/assistant-streaming.spec.ts` and `e2e/tabular-chat-lifecycle.spec.ts` form
the Playwright **`synthetic`** project. They mock every `/api` call in the
browser and need no backend, database, account or model-provider key, so CI
runs them in a separate job that serves only the web app. The streaming tests
are slow by design (4x CPU throttling and hundreds of SSE chunks, up to two
minutes each), and four of them on one 4-vCPU runner slowed each other about
2.5x, so the job is a matrix of three runners split by chat scope: `assistant`,
`project` and `rest` (every other synthetic test, so a new one is never
dropped), each on two workers. On every PR they report as **Assistant streaming
(production, assistant | project | rest)**; the `development` renderer against
`next dev` is a stress job. Keeping them out of the full-stack job is what
keeps that job short. See [frontend-testing.md](frontend-testing.md#assistant-streaming-regressions)
for a standalone local command.

Four live-provider cases remain key-gated; the synthetic streaming and history
stress cases always run. Use the current Playwright summary as the source of
truth for totals, failures and skips.

### Development stress jobs

Three jobs run against React's development renderer, which is 3-4x slower than
the production build: **`e2e / Playwright (development stress)`** (~25-35 min),
**`e2e / Assistant streaming (development, …)`** (~20-27 min before the split) and **`Word add-in /
Development stress (chromium + webkit)`** (~18-24 min). They were the last checks
to finish on every slow PR, so they are off the default PR path. They run:

- nightly (e2e at 03:47 UTC, the Word add-in at 04:17 UTC) and on manual
  dispatch;
- on every push to `main` (Word add-in only);
- on any PR carrying the **`stress`** label.

Add `stress` to PRs that touch streaming, render loops or effect dependencies.
The label is read when a run starts, so push a commit (or close and reopen the
PR) after adding it. There is deliberately no `labeled` trigger: a run started
by an unrelated label would report every check as skipped, and GitHub treats a
skipped required check as passing, which would hide an earlier red run.

Because these checks are absent on unlabelled PRs, do **not** mark them as
required status checks: a required check that never reports blocks the merge.

## Accessibility scans

`e2e/accessibility.spec.ts` runs an [axe-core](https://github.com/dequelabs/axe-core)
scan (via `@axe-core/playwright`) over the core pages: `/login` (pre-auth),
`/assistant`, `/projects`, and `/tabular-reviews`. The policy is two-tier:
**`critical`-impact violations fail the build**; `serious`-impact violations are
printed to the test output but do not fail — enforce at critical first, then
ratchet `serious` into the failing tier (`BLOCKING_IMPACTS` in the spec) once
that backlog is cleared. The scans need no LLM key and run on every trigger.

## Failure artifacts

The production suite retries failed specs up to twice on CI and records a
**trace** on the first retry. Development stress uses **zero retries** and
retains traces on failure, so an intermittent loop cannot pass on a retry.
On pass, fail, or timeout, each full-stack job uploads `playwright-report/`,
`test-results/` and the web-server log as **`playwright-report-production`** or
**`playwright-report-development`** (14-day retention). The focused development
job uploads **`assistant-streaming-development`** with the same failure evidence.
From the failed run's page in the Actions tab, download its artifact, then
`npx playwright show-report playwright-report` locally to see per-spec results,
screenshots, and step-by-step traces of what the browser did.

## Optional secret (fuller coverage)

| Secret | What it unlocks | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | The 4 LLM-dependent specs (chat rename/delete/submit, critical-path "ask a question") send a message and assert a **streamed** answer. With the key set they run and are enforced. | Those 4 specs **skip** (see `e2e/llm.ts`) instead of hanging, the remaining keyless cases still run. |

The suite is green **without** any secret — the LLM specs skip themselves via
`test.skip(!process.env.ANTHROPIC_API_KEY, …)`, which keeps keyless runs (local,
and fork PRs with no secret access) green and fast. Mike supports keyless local
models through Ollama, but this CI job does not provision an Ollama server or
pull a model. Without the Anthropic secret, the four live-response tests
therefore have no model available in the CI environment and must skip. The
auto title-generation call is not the reason for the gate; failures there are
already treated as best-effort.

## Enable the LLM specs

### 1. Add the repository secret

UI path:

1. Open the repository on GitHub → **Settings**.
2. In the left sidebar: **Secrets and variables → Actions**.
3. On the **Secrets** tab, click **New repository secret**.
4. **Name:** `ANTHROPIC_API_KEY` — exactly this name; both the workflow env and
   `e2e/llm.ts` read it. **Secret:** an Anthropic API key (`sk-ant-…`) from
   <https://console.anthropic.com/settings/keys>.
5. Click **Add secret**.

CLI equivalent (repo admin):

```bash
gh secret set ANTHROPIC_API_KEY --repo Open-Legal-Products/mike
# paste the key at the prompt (or pipe it: --body "$ANTHROPIC_API_KEY")
```

### 2. The fork-PR caveat

On `pull_request` events from **forks**, GitHub withholds repository secrets, so
fork PRs — most external contributions — still run keyless and skip the 4 specs.
That is by design and keeps those runs green. Runs that actually receive the
secret and exercise the specs are:

- PRs from branches pushed to this repository (maintainer branches), and
- manual runs: **Actions → e2e → Run workflow** (`workflow_dispatch`) on any
  branch.

So after adding the secret, the quickest way to see the specs run is a
`workflow_dispatch` run from the Actions tab.

### 3. Expected cost per run

A handful of short completions: one streamed chat answer per LLM spec plus a few
small title generations (`claude-haiku-4-5`, 64-token cap). On the order of a
few cents per run — negligible next to the CI minutes.

### 4. Confirm the specs ran (not skipped)

Open the **Run Playwright** step in the Actions log:

- **Keyless run:** the summary includes `4 skipped`, and each
  skipped spec carries the reason
  `requires a model key — set the ANTHROPIC_API_KEY secret to run LLM-dependent specs`.
- **With the secret:** all cases pass with **no `skipped` line**;
  searching the log for `requires a model key` finds nothing.

The uploaded `playwright-report-production` and `playwright-report-development`
artifacts show the same per-spec statuses.

### Model selection

When the secret is present, the shared `selectClaudeModel` helper selects a
supported Anthropic model before each gated test submits. The response checks
assert a nonempty streamed assistant answer rather than provider-specific text.
Keep that helper synchronized with the current model catalog when model ids or
display names change.

## Make it merge-blocking

The workflow failing is not enough on its own — GitHub will still allow the merge
unless the check is **required**. Enable branch protection once you have seen the
suite go green a few times (it is environment-sensitive by nature):

1. **Settings → Branches → Add branch protection rule** (or edit the rule for
   `main`).
2. Enable **Require status checks to pass before merging**.
3. Enable **Require branches to be up to date before merging**.
4. In the checks search box add **`e2e / playwright`**,
   the three **`e2e / Assistant streaming (production, assistant|project|rest)`** checks and
   **`Word add-in / Typecheck and Playwright (chromium + webkit)`**. Jobs appear
   in the list after they have run at least once on a PR. Do not require the
   development-stress checks; they only run on PRs labelled `stress` (see
   [Development stress jobs](#development-stress-jobs)).
5. Keep the existing unit/build, security and `license/cla` requirements.
6. Save. From now on a red e2e run blocks the **Merge** button.

This PR adds workflow checks; it does not edit repository protection settings.
When configuring them through an API, first read and preserve the existing
requirements and use the exact check contexts reported by the repository.

## Running the suite locally

Locally, `playwright.config.ts` starts the backend and web dev servers for you
(`webServer` is only disabled when `CI=true`), so a full local stack plus:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:e2e            # or test:e2e:ui / test:e2e:headed
```

`e2e/auth.setup.ts` reads `AUTH_URL` / `AUTH_SERVICE_KEY` from the
environment or `backend/.env`, so a running local GoTrue + a populated
`backend/.env` is all the setup needs. `npm run test:e2e:local`
(`scripts/e2e-local-stack.sh`) starts Postgres and GoTrue under their own
Compose project and writes those values for you.
