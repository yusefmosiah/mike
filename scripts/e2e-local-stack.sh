#!/usr/bin/env bash
# Boot the full local e2e stack and run the Playwright suite.
#
# Local-machine mirror of .github/workflows/e2e.yml: starts Postgres and GoTrue
# from docker-compose.yml under their own Compose project (mike-e2e, on its
# own ports, apart from the development stack's data), loads
# backend/schema.sql + backend/migrations/, points backend/.env and
# frontend/.env.local at them, then runs `npx playwright test`.
#
# Usage, from the repo root:
#   npm run test:e2e:local            # whole suite
#   npm run test:e2e:local -- -g "display name"   # extra args go to Playwright
#
# With --setup-only the script prepares the stack and exits without running
# Playwright — playwright.config.ts uses this in the backend webServer command
# so a plain `npm run test:e2e` also boots against a ready local stack.
#
# The first run rewrites the database and auth lines in your env files; the
# previous (e.g. hosted) versions are kept once as .env.hosted.bak /
# .env.local.hosted.bak. Restore those backups to point back at them.
set -euo pipefail

SETUP_ONLY=0
if [ "${1:-}" = "--setup-only" ]; then
    SETUP_ONLY=1
    shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running — start it first (open -a Docker) and retry." >&2
    exit 1
fi

export DB_PORT="${E2E_DB_PORT:-21422}"
export AUTH_PORT="${E2E_AUTH_PORT:-21421}"
export MAILPIT_PORT="${E2E_MAILPIT_PORT:-21425}"
export MAILPIT_SMTP_PORT="${E2E_MAILPIT_SMTP_PORT:-21426}"
export AUTH_PUBLIC_URL="http://localhost:$AUTH_PORT"
compose() { docker compose -p mike-e2e -f "$ROOT/docker-compose.yml" "$@"; }
psql_db() { compose exec -T db psql -U postgres -X "$@"; }

# Idempotent: if the stack is already up this is a no-op.
compose up -d --wait db auth

DB_URL="postgres://postgres:postgres@127.0.0.1:$DB_PORT/postgres"
AUTH_URL="http://localhost:$AUTH_PORT"
# The compose file's local demo service-role key, signed with its GoTrue secret.
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

# schema.sql is not idempotent, so only load it into a virgin database; the
# dated migrations ARE re-runnable and fill any gap schema.sql has (it lags —
# see docs/e2e-ci.md), so apply them every time.
if [ "$(psql_db -tAc "SELECT to_regclass('public.user_profiles') IS NULL")" = "t" ]; then
    echo "Loading schema.sql into fresh database…"
    psql_db -v ON_ERROR_STOP=1 -q <"$BACKEND/schema.sql" >/dev/null
fi
for m in "$BACKEND"/migrations/*.sql; do
    psql_db -q <"$m" >/dev/null 2>&1 ||
        echo "warning: migration returned non-zero (already applied?): $m"
done

# Rewrite only the database and auth lines of the env files, preserving
# everything else (API keys, R2 storage, …). Keep a one-time backup of the
# pre-local versions.
set_kv() {
    local file=$1 key=$2 value=$3
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        awk -v k="$key" -v v="$value" \
            'index($0, k"=") == 1 { print k "=" v; next } { print }' \
            "$file" >"$file.tmp" && mv "$file.tmp" "$file"
    else
        echo "${key}=${value}" >>"$file"
    fi
}

cd "$BACKEND"
[ -f .env ] || cp .env.example .env
[ -f .env.hosted.bak ] || cp .env .env.hosted.bak
set_kv .env AUTH_URL "$AUTH_URL"
set_kv .env AUTH_SERVICE_KEY "$SERVICE_KEY"
set_kv .env DATABASE_URL "$DB_URL"
# The suite fires well over the backend's default 300-requests/15-min general
# cap in one run; once tripped every call 429s and profile/list waits time out.
# Same overrides CI uses — e2e is not testing throttling.
set_kv .env RATE_LIMIT_GENERAL_MAX 100000
set_kv .env RATE_LIMIT_CHAT_MAX 100000
set_kv .env RATE_LIMIT_CHAT_CREATE_MAX 100000
set_kv .env RATE_LIMIT_EXPORT_MAX 100000
set_kv .env RATE_LIMIT_DATA_DELETE_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_POLL_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR 100000

touch "$FRONTEND/.env.local"
[ -f "$FRONTEND/.env.local.hosted.bak" ] || cp "$FRONTEND/.env.local" "$FRONTEND/.env.local.hosted.bak"
set_kv "$FRONTEND/.env.local" API_BASE_URL "http://localhost:3001"

echo "Local stack ready: auth $AUTH_URL, db ${DB_URL%%\?*}"

if [ "$SETUP_ONLY" = "1" ]; then
    exit 0
fi

echo "NOTE: kill any backend/frontend dev servers started before this script —"
echo "they hold the old env. playwright.config.ts starts fresh ones if none run."

cd "$ROOT"
npx playwright test "$@"
