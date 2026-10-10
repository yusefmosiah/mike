#!/usr/bin/env bash
# Boot the full local e2e stack and run the Playwright suite.
#
# Local-machine mirror of .github/workflows/e2e.yml: starts Postgres, GoTrue
# and RustFS from docker-compose.yml under their own Compose project (mike-e2e,
# on its own ports, apart from the development stack's data), loads
# backend/schema.sql + backend/migrations/ (via db-init), then runs `npx playwright test`.
# The stack's URLs and keys are passed to the backend and to Playwright as
# environment variables, which win over backend/.env: no env file is edited.
#
# Usage, from the repo root:
#   npm run test:e2e:local            # whole suite
#   npm run test:e2e:local -- -g "display name"   # extra args go to Playwright
#
#   --setup-only     prepare the stack and exit
#   --serve-backend  prepare the stack, then run the backend dev server against
#                    it (playwright.config.ts starts the backend this way, so a
#                    plain `npm run test:e2e` uses the same stack)
set -euo pipefail

MODE=run
case "${1:-}" in
--setup-only) MODE=setup; shift ;;
--serve-backend) MODE=serve; shift ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running — start it first (open -a Docker) and retry." >&2
    exit 1
fi

export DB_PORT="${E2E_DB_PORT:-21422}"
export AUTH_PORT="${E2E_AUTH_PORT:-21421}"
export MAILPIT_PORT="${E2E_MAILPIT_PORT:-21425}"
export MAILPIT_SMTP_PORT="${E2E_MAILPIT_SMTP_PORT:-21426}"
export STORAGE_PORT="${E2E_STORAGE_PORT:-21490}"
export STORAGE_CONSOLE_PORT="${E2E_STORAGE_CONSOLE_PORT:-21491}"
export AUTH_PUBLIC_URL="http://localhost:$AUTH_PORT"
compose() { docker compose -p mike-e2e -f "$ROOT/docker-compose.yml" "$@"; }

# Idempotent: if the stack is already up this is a no-op.
compose up -d --wait db auth storage
compose up createbucket >/dev/null

DB_URL="postgres://postgres:postgres@127.0.0.1:$DB_PORT/postgres"
AUTH_URL="http://localhost:$AUTH_PORT"
# The compose file's local demo service-role key, signed with its GoTrue secret.
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJtaWtlLWxvY2FsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.uD8koYAMq_1hAlVmm1t5PYasyb98YME7G_UYVa5ME1Y"

# The same db-init a Compose install runs: schema.sql into a new database,
# then backend/scripts/migrate.sh applies whatever the schema_migrations
# ledger does not list (a database from before the ledger is adopted once).
if ! compose run --rm db-init >"${TMPDIR:-/tmp}/mike-e2e-db-init.log" 2>&1; then
    tail -n 40 "${TMPDIR:-/tmp}/mike-e2e-db-init.log" >&2
    echo "db-init failed; full log: ${TMPDIR:-/tmp}/mike-e2e-db-init.log" >&2
    exit 1
fi

export AUTH_URL AUTH_SERVICE_KEY="$SERVICE_KEY" DATABASE_URL="$DB_URL"
export R2_ENDPOINT_URL="http://localhost:$STORAGE_PORT"
export R2_PUBLIC_ENDPOINT_URL="$R2_ENDPOINT_URL"
export R2_ACCESS_KEY_ID=rustfsadmin R2_SECRET_ACCESS_KEY=rustfsadmin R2_BUCKET_NAME=mike
export SENTRY_DISABLED=true
# The e2e account has no provider keys or saved router models of its own, so
# without this the model pickers are empty and creating a tabular review
# stops at "No models available". One configured endpoint is always offered:
# e2e/stubModel.mjs, a scripted OpenAI-compatible server that playwright.config.ts
# starts. Specs that need a real turn without a provider key (branching) send
# it to this model; the specs that need a real model choose their own.
E2E_STUB_MODEL_PORT="${E2E_STUB_MODEL_PORT:-21434}"
E2E_MODEL_CONFIG='{"models":[{"id":"e2e-placeholder","label":"E2E placeholder","provider":"openai-compatible","location":"local","baseUrl":"http://127.0.0.1:'"$E2E_STUB_MODEL_PORT"'/v1","apiModel":"e2e-placeholder"}]}'
export MIKE_MODEL_CONFIG_JSON="${MIKE_MODEL_CONFIG_JSON:-$E2E_MODEL_CONFIG}"
# The suite fires well over the backend's default 300-requests/15-min general
# cap in one run; once tripped every call 429s and profile/list waits time out.
# Same overrides CI uses — e2e is not testing throttling.
for cap in GENERAL CHAT CHAT_CREATE UPLOAD EXPORT DATA_DELETE UPLOAD_SESSION_MUTATION \
    UPLOAD_SESSION_POLL UPLOAD_SESSION_CREATE_MAX_PER_HOUR AUTH_LOGIN AUTH_ACCOUNT \
    AUTH_EMAIL AUTH_FLOW AUTH_MFA; do
    case "$cap" in
    *_PER_HOUR) export "RATE_LIMIT_${cap}=100000" ;;
    *) export "RATE_LIMIT_${cap}_MAX=100000" ;;
    esac
done

# Production runs the catalog sync as a release job before the backend starts;
# new accounts get their default workflows from it. Same pinned ref as CI.
export MIKE_WORKFLOWS_REF="${MIKE_WORKFLOWS_REF:-ce62e6a2d3f47e1d3567a4f2edc61898cfe9e78a}"
(cd "$BACKEND" && npx tsx src/jobs/syncWorkflows.ts)

echo "Local stack ready: auth $AUTH_URL, db ${DB_URL%%\?*}"

case "$MODE" in
setup) exit 0 ;;
serve) cd "$BACKEND" && exec npm run dev ;;
esac

echo "NOTE: Playwright reuses servers already listening on :3000 and :3001."
echo "Stop any that point at another stack (such as docker compose's) first."

cd "$ROOT"
exec npx playwright test "$@"
