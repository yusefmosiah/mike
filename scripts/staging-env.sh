#!/usr/bin/env bash
# Manage the staging backend's keys and model list on node-a.
#
# Staging (infra/node-a/staging.nix) builds the backend's environment from
# /var/lib/mike-staging/backend.env, which holds the model and search keys and
# MIKE_MODEL_CONFIG_JSON. Nothing in the repository or the deploy workflow
# writes that file; this script is how the operator changes it.
#
#   scripts/staging-env.sh status
#       Every key name on staging, and whether its value matches your local
#       backend/.env (same, differs, staging only), plus API keys you have
#       locally that staging lacks. Values are never printed.
#
#   scripts/staging-env.sh push KEY [KEY...]
#       Copy those keys' values from backend/.env to staging, then restart the
#       backend. Other lines in backend.env are left alone.
#
#   scripts/staging-env.sh pull-models
#       Write staging's MIKE_MODEL_CONFIG_JSON to infra/node-a/staging/models.json
#       (inline apiKey fields are dropped), so it can be reviewed and committed.
#
#   scripts/staging-env.sh push-models [--exact]
#       Send infra/node-a/staging/models.json to staging. By default each model
#       replaces the staging entry with the same id or is added, and entries
#       the file does not name are kept and listed. --exact makes staging's
#       list exactly the file's.
#
# Every write first copies backend.env to
# /var/lib/mike-staging/env-backups/backend.env.<UTC time> (the last 20 are
# kept), replaces the file atomically, and restarts the backend only if a
# value changed. Values travel over ssh on stdin, never in a command line.
#
# Environment:
#   STAGING_HOST      ssh destination (default node-a, root@51.81.93.94 in
#                     ~/.ssh/config)
#   STAGING_ENV_FILE  local source of values (default backend/.env)
#
# Requires jq and ssh access to node-a as root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${STAGING_HOST:-node-a}"
ENV_FILE="${STAGING_ENV_FILE:-${REPO_ROOT}/backend/.env}"
MODELS_FILE="${REPO_ROOT}/infra/node-a/staging/models.json"

die() { echo "staging-env: $*" >&2; exit 1; }

# Strip one pair of matching outer quotes, as Compose's env_file does.
unquote() {
  local v="$1"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# The last assignment of KEY in the local env file, unquoted. Not sourced:
# a value may hold JSON or shell metacharacters.
local_value() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  [ -n "$line" ] || return 1
  unquote "${line#*=}"
}

valid_key() { [[ "$1" =~ ^[A-Z_][A-Z0-9_]*$ ]]; }

# Runs on node-a. Mode in $1; input on stdin. Prints names and states only.
read -r -d '' REMOTE <<'REMOTE_EOF' || true
set -euo pipefail
root=/var/lib/mike-staging
f=$root/backend.env
umask 077
touch "$f"
unquote() {
  local v="$1"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}
remote_value() {
  local line
  line=$(grep -E "^$1=" "$f" | tail -n 1 || true)
  [ -n "$line" ] || return 1
  unquote "${line#*=}"
}
case "$1" in
  status)
    # stdin: "KEY sha256" for every local key.
    declare -A local_hash=()
    while read -r k h; do [ -n "$k" ] && local_hash[$k]=$h; done
    for k in $(grep -oE '^[A-Z_][A-Z0-9_]*=' "$f" | tr -d = | sort -u); do
      h=$(remote_value "$k" | sha256sum | cut -d' ' -f1)
      if [ -z "${local_hash[$k]:-}" ]; then echo "$k	staging only"
      elif [ "${local_hash[$k]}" = "$h" ]; then echo "$k	same"
      else echo "$k	differs"; fi
    done
    for k in "${!local_hash[@]}"; do
      if [[ "$k" == *_API_KEY ]] && ! grep -qE "^$k=" "$f"; then echo "$k	local only"; fi
    done | sort ;;
  models)
    remote_value MIKE_MODEL_CONFIG_JSON || true ;;
  upsert)
    # stdin: KEY=VALUE lines.
    new=$(mktemp "$root/.backend.env.XXXXXX")
    trap 'rm -f "$new" "$new.next"' EXIT
    cp "$f" "$new"
    changed=0
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      k=${line%%=*}
      v=$(unquote "${line#*=}")
      if old=$(remote_value "$k"); then
        if [ "$old" = "$v" ]; then echo "$k: unchanged"; continue; fi
        echo "$k: changed"
      else
        echo "$k: added"
      fi
      changed=1
      grep -vE "^$k=" "$new" > "$new.next" || true
      printf '%s\n' "$line" >> "$new.next"
      mv "$new.next" "$new"
    done
    if [ "$changed" = 0 ]; then echo "nothing changed; backend not restarted"; exit 0; fi
    mkdir -p "$root/env-backups"
    backup="$root/env-backups/backend.env.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$f" "$backup"
    ls -1t "$root"/env-backups/backend.env.* | tail -n +21 | xargs -r rm -f
    chmod 600 "$new"
    mv "$new" "$f"
    trap - EXIT
    echo "backed up the previous file to $backup"
    # reload-env restarts only the backend; a host whose staging tool predates
    # it gets a full deploy of the tree it already serves.
    usage=$(mike-staging 2>&1 || true)
    if grep -q reload-env <<<"$usage"; then
      mike-staging reload-env
    else
      echo "this host's mike-staging has no reload-env yet; running deploy"
      exec 9>"$root/deploy.lock"
      flock -w 600 9 || { echo "a deploy still holds the lock; run mike-staging deploy later" >&2; exit 1; }
      mike-staging deploy
    fi
    for _ in $(seq 30); do
      if mike-staging health >/dev/null 2>&1; then echo "backend restarted; staging healthy"; exit 0; fi
      sleep 5
    done
    echo "staging is not healthy after the restart; restore with: cp $backup $f && mike-staging reload-env" >&2
    exit 1 ;;
  *) echo "unknown mode" >&2; exit 2 ;;
esac
REMOTE_EOF

# The script goes base64-encoded in the command line (it holds no secrets);
# stdin stays free for the values.
remote() {
  local b64
  b64=$(printf '%s' "$REMOTE" | base64 | tr -d '\n')
  ssh "$HOST" "bash -c \"\$(echo $b64 | base64 -d)\" staging-env $1"
}

# Sends KEY=VALUE lines from stdin to staging.
upsert() { remote upsert; }

command -v jq >/dev/null || die "jq is required"

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  status)
    [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
    grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" | tr -d = | sort -u | while read -r k; do
      printf '%s %s\n' "$k" "$(local_value "$k" | shasum -a 256 | cut -d' ' -f1)"
    done | remote status | column -t -s "$(printf '\t')" ;;

  push)
    [ $# -gt 0 ] || die "name the keys to push, e.g. push OPENGATEWAY_API_KEY"
    [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
    payload=""
    for k in "$@"; do
      valid_key "$k" || die "$k is not an environment variable name"
      [ "$k" != MIKE_MODEL_CONFIG_JSON ] || die "use push-models for MIKE_MODEL_CONFIG_JSON"
      v=$(local_value "$k") || die "$k is not set in $ENV_FILE"
      [ -n "$v" ] || die "$k is empty in $ENV_FILE"
      payload="${payload}${k}=${v}"$'\n'
    done
    echo "pushing $* to $HOST"
    printf '%s' "$payload" | upsert ;;

  pull-models)
    current=$(remote models </dev/null)
    [ -n "$current" ] || die "staging has no MIKE_MODEL_CONFIG_JSON"
    if jq -e '[.models[] | select(has("apiKey"))] | length > 0' <<<"$current" >/dev/null; then
      echo "dropping inline apiKey fields; name the key with apiKeyEnv instead" >&2
    fi
    jq 'del(.models[].apiKey)' <<<"$current" > "$MODELS_FILE"
    echo "wrote $(jq '.models | length' "$MODELS_FILE") models to ${MODELS_FILE#"$REPO_ROOT"/}:"
    jq -r '.models[].id' "$MODELS_FILE" | sed 's/^/  /' ;;

  push-models)
    exact=0
    [ "${1:-}" = --exact ] && exact=1
    [ -f "$MODELS_FILE" ] || die "${MODELS_FILE#"$REPO_ROOT"/} not found; run pull-models first"
    jq -e '.models | type == "array"' "$MODELS_FILE" >/dev/null || die "models.json needs a models array"
    if jq -e '[.models[] | select(has("apiKey"))] | length > 0' "$MODELS_FILE" >/dev/null; then
      die "models.json has an inline apiKey; use apiKeyEnv and push the key itself"
    fi
    if [ "$exact" = 1 ]; then
      merged=$(jq -c . "$MODELS_FILE")
    else
      current=$(remote models </dev/null)
      [ -n "$current" ] || current='{"models":[]}'
      # File entries win by id; staging-only entries stay, in their order.
      merged=$(jq -c --slurpfile file "$MODELS_FILE" '
        ($file[0].models | map(.id)) as $ids
        | .models = ([.models[] | select(.id as $id | $ids | index($id) | not)] + $file[0].models)
      ' <<<"$current")
      kept=$(jq -r --slurpfile file "$MODELS_FILE" '
        ($file[0].models | map(.id)) as $ids
        | .models[] | select(.id as $id | $ids | index($id) | not) | .id
      ' <<<"$current")
      if [ -n "$kept" ]; then
        echo "kept on staging, not in models.json (pull-models adopts them, --exact drops them):"
        printf '%s\n' "$kept" | sed 's/^/  /'
      fi
    fi
    # The keys each model names, so a missing one shows up before a chat fails.
    for k in $(jq -r '.models[].apiKeyEnv // empty' <<<"$merged" | sort -u); do
      echo "uses $k"
    done
    echo "sending $(jq '.models | length' <<<"$merged") models to $HOST"
    # Single quotes keep Compose from reading " #" in a label as a comment.
    if [[ "$merged" == *"'"* ]]; then line="MIKE_MODEL_CONFIG_JSON=$merged"
    else line="MIKE_MODEL_CONFIG_JSON='$merged'"; fi
    printf '%s\n' "$line" | upsert ;;

  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
    [ -z "$cmd" ] || [ "$cmd" = help ] || [ "$cmd" = -h ] || exit 2 ;;
esac
