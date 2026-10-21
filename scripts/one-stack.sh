#!/usr/bin/env bash
# Keep one of this repository's Docker stacks running at a time.
#
# Usage: scripts/one-stack.sh <project-to-keep>
#
# Stops every other running Compose project whose name starts with "mike"
# (the development stack `mike`, `mike-e2e`, `mike-stack-test`, review
# stacks). Stopped, not removed: containers and data volumes stay, and
# `docker compose -p <name> start` brings one back. Two stacks at once is how
# a test run ends up talking to the wrong one: Playwright reuses whatever
# already listens on :3000 and :3001, and the development stack's frontend
# and backend do.
#
# Set MIKE_ONE_STACK=0 to leave the other stacks running.
set -euo pipefail

keep="${1:?usage: one-stack.sh <project-to-keep>}"
[ "${MIKE_ONE_STACK:-1}" = "0" ] && exit 0
# No Docker, nothing to stop; the caller reports a missing Docker itself.
docker info >/dev/null 2>&1 || exit 0

docker ps --format '{{.Label "com.docker.compose.project"}}' |
    sort -u |
    while read -r project; do
        case "$project" in
        "$keep" | "") ;;
        mike | mike-*)
            echo "Stopping the $project stack so only $keep runs (MIKE_ONE_STACK=0 keeps it)." >&2
            docker compose -p "$project" stop >/dev/null
            ;;
        esac
    done
