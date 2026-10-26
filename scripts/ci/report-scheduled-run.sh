#!/usr/bin/env bash
# Report a scheduled workflow's outcome to one standing issue.
#
#   report-scheduled-run.sh <label> <issue title>
#
# Reads RESULTS (the workflow's `toJSON(needs)`), RUN_URL and GH_TOKEN from
# the environment. Any failed job opens the issue labelled <label>, or
# comments on it if it is already open; a run with no failures closes it.
# One issue per label, so a check that fails every night is reported once.
set -euo pipefail

label="$1"
title="$2"

failed=$(jq -r 'to_entries[] | select(.value.result == "failure" or .value.result == "cancelled") | "- `\(.key)`: \(.value.result)"' <<<"$RESULTS")
issue=$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')

if [ -n "$failed" ]; then
  body=$(printf 'Failed in %s:\n\n%s\n\nRead the failures with `gh run view <run id> --log-failed`; see docs/ci.md.' "$RUN_URL" "$failed")
  if [ -n "$issue" ]; then
    gh issue comment "$issue" --body "$body"
  else
    gh label create "$label" --color B60205 --description "A scheduled check is failing" 2>/dev/null || true
    gh issue create --title "$title" --label "$label" --body "$body"
  fi
  echo "$failed"
elif [ -n "$issue" ]; then
  gh issue close "$issue" --comment "Green again in $RUN_URL."
fi
