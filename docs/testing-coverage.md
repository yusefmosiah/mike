# Backend unit-test coverage

The backend has a Vitest unit-test harness whose coverage ratchet measures all
of `backend/src/**` — modules, workers, middleware and jobs included, not just
`src/lib/**`, so an untested area cannot silently drop to zero. This doc tracks
how to measure that scope and maintain its ratchet. Current product acceptance and
priorities live in [the whole-project accounting](../goals/TRIAGE.md), not a test-file checklist.

## Running the tests

```bash
cd backend
npm install
npm test              # run all unit tests
npm run test:coverage # same, plus the per-file coverage table + floor check
```

Tests live throughout `backend/src/**/*.test.ts`, including `lib/__tests__/`,
nested feature directories, `modules/<domain>/__tests__/`, and
`src/__tests__/integration/`. `src/__tests__/architecture.test.ts` enforces
the module layering described in `docs/backend-architecture.md`.
Read a couple of the existing suites first (`lib/__tests__/access.test.ts`,
`lib/__tests__/userDataCleanup.test.ts`) and match their conventions: plain
in-memory database query mocks for unit tests, no real network, one `describe`
block per function or concern, and assertions on current behavior. Tests that
need a real local Postgres + GoTrue stack are explicitly gated.

## Coverage evidence and regression priorities

The old August percentage table and unchecked "untested libs" PR list have been
removed. Refactors and subsequent suites made them unsuitable as a current
measurement or work queue. A stale "0%" row is not evidence that current code has
no tests.

Run `npm run test:coverage --prefix backend` when current coverage is needed.
Record the source revision, measured scope, command, output and skipped tests.
Configured floors are not freshly measured percentages, and line coverage does
not prove behavior or private-deployment acceptance.

Choose regressions from consumer-visible risk: authorization and revocation,
document-version lifecycle and reversible edits, source/citation provenance,
provider/context-overflow behavior, streaming recovery and safe error handling.
Inspect existing module/lib suites before adding tests. Keep tests deterministic
and isolated; use real local services only through documented stack fixtures.
Do not add tests for source wording, trivial forwarding, copied mock arguments or
incidental implementation shape.

The prior default-concurrency corpus timeouts and reduced-concurrency passing
run remain dated evidence in [`goals/TRIAGE.md`](../goals/TRIAGE.md#3-source-deployment-and-acceptance-receipts).
Their cause is not established. This documentation cleanup neither reruns those
checks nor changes timeouts or workers to suppress the failures.


## Ratchet policy

`backend/vitest.config.mts` enforces global coverage **floors** (currently
statements 60 / branches 51 / functions 64 / lines 63). They are a
no-regression ratchet, not a target:

`.github/workflows/ci.yml` defines the coverage check. A workflow definition does
not prove that this fork has run it or configured required branch checks; verify
repository enforcement separately. The earlier fork audit found no runs and
unprotected main, as recorded in `goals/TRIAGE.md`. Rules:

- **Floors only go up.** Never lower them to get a PR green — that means your
  change removed tested behavior or added a large untested lib; add tests
  instead.
- **Raise them in the same PR that adds tests.** After your suite passes, run
  `npm run test:coverage`, take the new global numbers, and set each floor to
  the measured value rounded down to a whole percent.
- Keep measurements revision-bound. Change a threshold only with observed output;
  do not recreate an undated per-file snapshot as the current backlog.
