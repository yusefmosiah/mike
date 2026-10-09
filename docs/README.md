# Documentation

## Run and deploy Mike

- [Local development](local-development.md) — Docker Compose, local services,
  registration, Ollama, and first-run setup
- [Manual and production deployment](deployment.md) — managed infrastructure,
  environment variables, database upgrades, and deployment safety
- [Current project agenda](../goals/STATUS.md) — current mission state, owner
  constraints, and proposed course
- [Whole-project accounting](../goals/TRIAGE.md) — all phases/missions, omitted
  requests, inherited release obligations, evidence levels and dependencies
- [Program accounting letter](reports/mike-program-accounting-2026-10-07.md) —
  readable explanation of the standing state and proposed course
- [Troubleshooting](troubleshooting.md) — common local and production problems
- [Safe local testing](safe-local-testing.md) — disposable resources, synthetic
  documents, and secret handling

## Features and clients

- [MCP connectors](connectors.md) — hosted presets, custom servers, OAuth,
  redirect URIs, and Slack/Google deployment setup
- [Scoped memory](memory.md) — app and project Markdown memory, permissions,
  asynchronous learning, deletion, and operations
- [CourtListener integration](courtlistener.md) — live US case-law tools and
  optional bulk data
- [Microsoft Word add-in](../word-addin/README.md) — concise setup and command
  reference
- [Word add-in development and deployment](word-addin-development.md) — manual
  setup, sideloading, builds, storage behavior, testing, and troubleshooting
- [Tamper-evident exports](tamper-evident-exports.md) — document hashes and
  optional signed manifests
- [Decision models](decision-models.md) — the Auto Mode gate's questions,
  consent-aware policy, injection hardening and eval method, with the
  [2026-10-09 eval report](reports/auto-mode-gate-eval-2026-10-09.md)

## Backend

- [Backend architecture](backend-architecture.md) — domain modules over a
  shared kernel: module anatomy, the service contract, the layering rules, and
  the fitness test that enforces them

## Frontend

- [Design system](design-system.md) — color/typography/spacing tokens, the shared
  `components/ui` primitives, and the accessibility baseline

## Testing and CI

- [End-to-end tests in CI](e2e-ci.md)
- [Backend unit-test coverage](testing-coverage.md)
- [Frontend unit-test coverage](frontend-testing.md)
- [Mutation testing and the SSE load harness](test-depth.md)

## Open-source acknowledgments

- [Open-source credits](../CREDITS.md) — the libraries, tools, and
  infrastructure behind Mike

## Investigation evidence

These dated investigations preserve measured behavior and unresolved acceptance
cases. They are evidence for their recorded revisions, not current setup guidance.

- [Word add-in assistant scroll-jump report](word-addin-chat-scroll-report.md)

Contribution and disclosure policies live in [CONTRIBUTING.md](../CONTRIBUTING.md)
and [SECURITY.md](../SECURITY.md).
