#!/usr/bin/env bash
# Move a Docker Compose install's data off the Supabase Postgres image.
#
# Mike's Compose stack used to run supabase/postgres on the `db_data` volume;
# it now runs stock Postgres on `postgres_data`. This copies the three schemas
# that hold Mike's data — auth (accounts, from GoTrue), public (application
# data) and pi_durable (chat transcripts) — from the old volume into the new
# one. Supabase's own schemas (storage, realtime, vault, graphql, ...) held
# nothing of Mike's and stay behind, as do grants to Supabase-only roles.
#
# The old volume is only read, never changed: once the new stack checks out,
# delete it yourself (the script prints the command).
#
# Usage, from the repository root, with the stack stopped:
#   docker compose down
#   scripts/migrate-supabase-db.sh
#   docker compose up -d
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEGACY_IMAGE="supabase/postgres:17.6.1.136"
LEGACY_CONTAINER="mike-legacy-supabase-db"

compose() { docker compose -f "$ROOT/docker-compose.yml" "$@"; }

PROJECT="$(compose config | sed -n 's/^name: //p' | head -1)"
OLD_VOLUME="${PROJECT}_db_data"

if ! docker volume inspect "$OLD_VOLUME" >/dev/null 2>&1; then
    echo "No $OLD_VOLUME volume: nothing to migrate." >&2
    exit 0
fi
if [ -n "$(docker ps -q --filter "volume=$OLD_VOLUME")" ]; then
    echo "A container is still using $OLD_VOLUME. Stop the stack first: docker compose down" >&2
    exit 1
fi

WORK="$(mktemp -d)"
cleanup() {
    docker rm -f "$LEGACY_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "Starting the old database read-only from ${OLD_VOLUME}…"
docker rm -f "$LEGACY_CONTAINER" >/dev/null 2>&1 || true
# The image's own command, plus read-only transactions. supabase_admin is its
# superuser, with the POSTGRES_PASSWORD the Compose file gave it.
docker run -d --name "$LEGACY_CONTAINER" \
    -v "$OLD_VOLUME:/var/lib/postgresql/data" \
    -e POSTGRES_PASSWORD=postgres \
    "$LEGACY_IMAGE" \
    postgres -D /etc/postgresql -c default_transaction_read_only=on >/dev/null
legacy() { docker exec -i -e PGPASSWORD=postgres "$LEGACY_CONTAINER" "$@"; }
for _ in $(seq 1 60); do
    legacy pg_isready -U supabase_admin -h 127.0.0.1 >/dev/null 2>&1 && break
    sleep 1
done
legacy_psql() { legacy psql -U supabase_admin -h 127.0.0.1 -d postgres -XAtq "$@"; }
if [ "$(legacy_psql -c "select to_regclass('public.user_profiles') is not null")" != "t" ]; then
    echo "The old volume holds no Mike data; nothing to migrate." >&2
    exit 0
fi
USERS="$(legacy_psql -c "select count(*) from auth.users")"
echo "Found $USERS accounts. Dumping auth, public and pi_durable…"
SCHEMAS=(-n auth -n public)
if [ "$(legacy_psql -c "select to_regnamespace('pi_durable') is not null")" = "t" ]; then
    SCHEMAS+=(-n pi_durable)
fi
legacy pg_dump -U supabase_admin -h 127.0.0.1 -Fc --no-owner "${SCHEMAS[@]}" postgres >"$WORK/mike.dump"
docker rm -f "$LEGACY_CONTAINER" >/dev/null

echo "Starting the new database…"
compose up -d --wait db
new_psql() { compose exec -T db psql -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
if [ "$(new_psql -Atq -c "select to_regclass('public.user_profiles') is not null")" = "t" ]; then
    echo "The new database already holds Mike data; refusing to overwrite it." >&2
    exit 1
fi
if [ "$(new_psql -Atq -c "select to_regclass('auth.users') is not null")" = "t" ] &&
    [ "$(new_psql -Atq -c "select count(*) from auth.users")" != "0" ]; then
    echo "The new database already has accounts; refusing to overwrite them." >&2
    exit 1
fi

# GoTrue may have built an empty auth schema on a start before this script;
# the dump brings the real one. Extensions are not part of a schema dump.
new_psql -q <<'SQL'
drop schema if exists auth cascade;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
SQL

echo "Restoring tables and data…"
DB_CONTAINER="$(compose ps -q db)"
docker cp "$WORK/mike.dump" "$DB_CONTAINER:/tmp/mike.dump"
# Everything but the public schema itself, which every database already has.
compose exec -T db sh -c "pg_restore -l /tmp/mike.dump | grep -vE ' (SCHEMA - public|COMMENT - SCHEMA public) ' >/tmp/mike.list"
compose exec -T db pg_restore -U postgres -d postgres -L /tmp/mike.list --no-owner --no-acl --exit-on-error /tmp/mike.dump

# Grants come separately, one statement each, so a grant to a role only the
# Supabase image had (supabase_admin, dashboard_user, ...) is skipped while the
# rest — including schema.sql's grants to anon, authenticated and
# service_role — apply.
echo "Restoring grants…"
compose exec -T db sh -c "pg_restore -l /tmp/mike.dump | grep -E ' (ACL|DEFAULT ACL) ' >/tmp/mike-acl.list || true"
compose exec -T db sh -c "pg_restore -L /tmp/mike-acl.list --no-owner -f - /tmp/mike.dump | psql -U postgres -X -q" \
    2>"$WORK/acl.err" >/dev/null || true
compose exec -T db rm -f /tmp/mike.dump /tmp/mike.list /tmp/mike-acl.list
SKIPPED="$(grep -c 'does not exist' "$WORK/acl.err" || true)"
OTHER="$(grep 'ERROR' "$WORK/acl.err" | grep -v 'does not exist' || true)"
echo "Skipped $SKIPPED grants to roles this database does not have."
if [ -n "$OTHER" ]; then
    echo "Unexpected grant errors:" >&2
    echo "$OTHER" >&2
    exit 1
fi

# GoTrue owns its schema: it runs its own migrations there on upgrades.
echo "Handing the auth schema to GoTrue's role…"
new_psql -q <<'SQL'
alter schema auth owner to supabase_auth_admin;
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as obj from pg_class c
    where c.relnamespace = 'auth'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('alter table %s owner to supabase_auth_admin', r.obj);
  end loop;
  -- Sequences a column owns follow their table; the rest move on their own.
  for r in
    select c.oid::regclass as obj from pg_class c
    where c.relnamespace = 'auth'::regnamespace and c.relkind = 'S'
      and not exists (select from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))
  loop
    execute format('alter sequence %s owner to supabase_auth_admin', r.obj);
  end loop;
  for r in select p.oid::regprocedure as obj from pg_proc p where p.pronamespace = 'auth'::regnamespace loop
    execute format('alter function %s owner to supabase_auth_admin', r.obj);
  end loop;
  for r in
    select t.oid::regtype as obj from pg_type t
    where t.typnamespace = 'auth'::regnamespace and t.typtype in ('e', 'd', 'c')
      and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
  loop
    execute format('alter type %s owner to supabase_auth_admin', r.obj);
  end loop;
end $$;
SQL

MOVED="$(new_psql -Atq -c "select count(*) from auth.users")"
echo "Moved $MOVED of $USERS accounts and all of Mike's data into ${PROJECT}_postgres_data."
echo
echo "Start the stack:  docker compose up -d"
echo "Once it checks out, the old volume can go:  docker volume rm $OLD_VOLUME"
echo "(After that, legacy-data-check has nothing left to guard.)"
