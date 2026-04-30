#!/usr/bin/env bash
# Cross-connector regression sweep — final gate after a per-connector fix.
#
# Runs `npm test` (vitest run, or node:test for apple-shortcuts) for every
# connector in the monorepo (25 total). Concurrency is capped at 4 per the
# mission-readiness budget (14 cores / 48 GB RAM). Total wall-clock budget
# is ≤ 10 minutes.
#
# Exit status is 0 only if every connector's suite passes. Any failure
# is reported with the connector name and the tail of its log.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONNECTORS=(
  apple-shortcuts
  browser-automation
  elevenlabs
  email-imap
  fathom
  freshdesk
  gamma
  google-analytics
  humaans
  kling
  mixmax
  nano-banana
  napkin
  office
  outreach
  pandadoc
  quickbooks
  retell-ai
  runway
  salesforce
  servicenow
  talentlms
  workday
  zendesk
)

# _template excluded — starter scaffolding, no production tests gate the
# mission on it.

CONCURRENCY="${REGRESSION_CONCURRENCY:-4}"
LOG_DIR="$(mktemp -d -t mcp-regression-XXXXXX)"
echo "[regression] log dir: $LOG_DIR"
echo "[regression] concurrency: $CONCURRENCY"
echo "[regression] connectors: ${#CONNECTORS[@]}"

run_one() {
  local connector="$1"
  local log="$LOG_DIR/$connector.log"
  if (cd "connectors/$connector" && npm test) >"$log" 2>&1; then
    printf '[regression] PASS %s\n' "$connector"
    return 0
  else
    printf '[regression] FAIL %s (see %s)\n' "$connector" "$log"
    return 1
  fi
}

export -f run_one
export LOG_DIR

# Run with bounded concurrency using xargs -P.
printf '%s\n' "${CONNECTORS[@]}" \
  | xargs -P "$CONCURRENCY" -I{} bash -c 'run_one "$@"' _ {}
status=$?

echo
if [ $status -eq 0 ]; then
  echo "[regression] ALL ${#CONNECTORS[@]} CONNECTORS PASSED"
else
  echo "[regression] FAILURES OBSERVED — see $LOG_DIR"
  for c in "${CONNECTORS[@]}"; do
    log="$LOG_DIR/$c.log"
    if [ -f "$log" ] && grep -q -E 'FAIL|failed|✘|×' "$log" 2>/dev/null; then
      echo
      echo "::: $c :::"
      tail -40 "$log"
    fi
  done
fi

exit $status
