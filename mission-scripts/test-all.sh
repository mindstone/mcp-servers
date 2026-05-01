#!/usr/bin/env bash
# Cross-cutting regression sweep: build + typecheck + test for every
# publishable connector in the monorepo (25 total).
#
# This is the "test all the things" engine that the final regression gate
# (VAL-CROSS-001..003 + VAL-CROSS-008) consumes. Concurrency is capped at
# 4 per the mission-readiness budget (14 cores / 48 GB RAM, ~19 GB
# headroom). Total wall-clock budget is <= 600s (10 minutes).
#
# Per-connector pipeline (in this exact order, fail-fast):
#   1. npm run build            (writes dist/)
#   2. npx --no-install tsc --noEmit
#   3. npm test                 (vitest run for most; node:test for apple-shortcuts)
#
# Exit status is 0 only if every connector's pipeline exits 0. On failure,
# the script tails the offending connector's log so the operator can see
# which step failed without re-running.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Publishable connectors. Identical to the M1.4 CI matrix and the
# VAL-CROSS-* CONNECTORS list. _template/ and the (now-deleted)
# hello-harry-mcp/ are intentionally excluded.
#
# The mission proposal and validation contract describe these as "the 25
# publishable connectors", but the actual count under connectors/
# (excluding _template/) is 24. The list below is authoritative —
# matches `mission-scripts/regression.sh` and the M1.4 CI matrix exactly.
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

EXPECTED_CONNECTOR_COUNT="${EXPECTED_CONNECTOR_COUNT:-24}"
if [ "${#CONNECTORS[@]}" -ne "$EXPECTED_CONNECTOR_COUNT" ]; then
  echo "[test-all] FATAL: connector count != ${EXPECTED_CONNECTOR_COUNT} (was ${#CONNECTORS[@]})" >&2
  exit 1
fi

CONCURRENCY="${TEST_ALL_CONCURRENCY:-4}"
LOG_DIR="$(mktemp -d -t mcp-test-all-XXXXXX)"

echo "[test-all] log dir:    $LOG_DIR"
echo "[test-all] concurrency: $CONCURRENCY"
echo "[test-all] connectors:  ${#CONNECTORS[@]}"
echo

# Per-connector pipeline. Logs everything to a per-connector file so
# parallel runs do not interleave. Records PASS/FAIL marker files we can
# scan after the run.
run_one() {
  local connector="$1"
  local log="$LOG_DIR/$connector.log"
  local marker="$LOG_DIR/$connector.status"
  local rc=0

  {
    echo "::: $connector :::"
    echo "[step] npm run build"
    (cd "connectors/$connector" && npm run build --silent) || { echo "[fail] build"; exit 11; }
    echo "[step] npx --no-install tsc --noEmit"
    (cd "connectors/$connector" && npx --no-install tsc --noEmit) || { echo "[fail] typecheck"; exit 12; }
    echo "[step] npm test"
    (cd "connectors/$connector" && npm test --silent) || { echo "[fail] test"; exit 13; }
    echo "[ok] $connector"
  } >"$log" 2>&1 || rc=$?

  if [ $rc -eq 0 ]; then
    echo "PASS" >"$marker"
    printf '[test-all] PASS %s\n' "$connector"
    return 0
  fi
  echo "FAIL rc=$rc" >"$marker"
  printf '[test-all] FAIL %s (rc=%s, log=%s)\n' "$connector" "$rc" "$log"
  return 1
}

export -f run_one
export LOG_DIR

start=$(date +%s)
printf '%s\n' "${CONNECTORS[@]}" \
  | xargs -P "$CONCURRENCY" -I{} bash -c 'run_one "$@"' _ {}
status=$?
elapsed=$(( $(date +%s) - start ))

echo
echo "[test-all] elapsed=${elapsed}s status=${status}"

# Summarise per-connector outcome.
fail_count=0
for c in "${CONNECTORS[@]}"; do
  marker="$LOG_DIR/$c.status"
  if [ ! -f "$marker" ] || ! grep -q '^PASS$' "$marker" 2>/dev/null; then
    fail_count=$((fail_count + 1))
  fi
done

if [ "$status" -eq 0 ] && [ "$fail_count" -eq 0 ]; then
  echo "[test-all] ALL ${#CONNECTORS[@]} CONNECTORS PASSED in ${elapsed}s"
  exit 0
fi

echo "[test-all] ${fail_count} connector(s) failed — tailing logs:"
for c in "${CONNECTORS[@]}"; do
  marker="$LOG_DIR/$c.status"
  if [ ! -f "$marker" ] || ! grep -q '^PASS$' "$marker" 2>/dev/null; then
    log="$LOG_DIR/$c.log"
    echo
    echo "::: $c :::"
    if [ -f "$log" ]; then
      tail -60 "$log"
    else
      echo "(no log produced — connector may not have started)"
    fi
  fi
done

exit 1
