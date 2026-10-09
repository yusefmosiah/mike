#!/usr/bin/env bash
# Run the gated stack-level integration tests against a real Postgres + GoTrue.
#
# These tests exercise the REAL services (GoTrue auth + Postgres) instead of
# mocks. They are the harness you re-run on every GoTrue or Postgres bump to
# prove the auth↔API contract and the deny-all RLS firewall still hold.
#
# Both services come from docker-compose.yml, started under their own Compose
# project on their own ports, so the run never touches the development
# stack's data. The project's volume persists between runs; set
# STACK_TEST_FRESH=1 to start from an empty database.
#
# Usage:  npm run test:stack        (from backend/; needs Docker)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd -- "$BACKEND_DIR/.." && pwd)"
SCHEMA_FILE="$BACKEND_DIR/schema.sql"

PROJECT="${STACK_TEST_PROJECT:-mike-stack-test}"
# Low dedicated ports: clear of the development stack and of Linux's
# ephemeral range, where CI runners' outbound connections land.
export DB_PORT="${STACK_TEST_DB_PORT:-21322}"
export AUTH_PORT="${STACK_TEST_AUTH_PORT:-21321}"
export MAILPIT_PORT="${STACK_TEST_MAILPIT_PORT:-21325}"
export MAILPIT_SMTP_PORT="${STACK_TEST_MAILPIT_SMTP_PORT:-21326}"
export AUTH_PUBLIC_URL="http://127.0.0.1:$AUTH_PORT"

if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found: the stack tests start Postgres and GoTrue in containers." >&2
    exit 1
fi

compose() { docker compose -p "$PROJECT" -f "$REPO_DIR/docker-compose.yml" "$@"; }

if [[ "${STACK_TEST_FRESH:-}" == "1" ]]; then
    compose down -v --remove-orphans
fi
compose up -d --wait db auth

# GoTrue has built auth.users by the time it reports healthy. Load Mike's
# schema into an empty database only: silently resetting or modifying an
# existing application database would be surprising.
PROJECTS_TABLE="$(compose exec -T db psql -U postgres -XAtq -c "select to_regclass('public.projects');")"
if [[ "$PROJECTS_TABLE" != "projects" ]]; then
    echo "Mike schema not found; loading $SCHEMA_FILE"
    compose exec -T db psql -U postgres -X --set ON_ERROR_STOP=1 -q <"$SCHEMA_FILE" >/dev/null
fi

export DATABASE_TEST_URL="postgres://postgres:postgres@127.0.0.1:$DB_PORT/postgres"
export AUTH_TEST_URL="http://127.0.0.1:$AUTH_PORT"
# The compose file's local demo service-role key, signed with its GoTrue secret.
export AUTH_TEST_SERVICE_KEY="${AUTH_TEST_SERVICE_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU}"

echo "Running stack integration tests against $AUTH_TEST_URL and $DATABASE_TEST_URL"
cd "$BACKEND_DIR"
exec npx vitest run src/__tests__/integration/*.stack.test.ts "$@"
