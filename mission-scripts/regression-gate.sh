#!/usr/bin/env bash
# Final cross-cutting regression gate.
#
# Orchestrates the VAL-CROSS-001..010 and VAL-MISC-901..902 assertions
# from the mission validation contract. Designed to be the LAST check
# before declaring the mission complete.
#
# Each assertion either passes (the script prints `[gate] PASS <id>`) or
# fails (the script prints `[gate] FAIL <id>` and continues so the
# operator gets a complete picture). The script's exit status is the
# total number of failed assertions (0 == all green).
#
# The heavy build+typecheck+test sweep is delegated to test-all.sh so
# that the time budget for VAL-CROSS-008 is enforced by the same code
# that satisfies VAL-CROSS-001..003.
#
# Usage: bash mission-scripts/regression-gate.sh
#
# Required tools (verified at readiness time): node, npm, actionlint,
# rg (ripgrep), jq, python3.

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

# The mission proposal calls out "the 25 publishable connectors" but
# the repo actually has 24 publishable connectors under connectors/
# (excluding _template/). The CI matrix in `.github/workflows/ci.yml`
# also has 24 entries. We treat 24 as authoritative.
EXPECTED_CONNECTOR_COUNT="${EXPECTED_CONNECTOR_COUNT:-24}"
if [ "${#CONNECTORS[@]}" -ne "$EXPECTED_CONNECTOR_COUNT" ]; then
  echo "[gate] FATAL: connector count != ${EXPECTED_CONNECTOR_COUNT}" >&2
  exit 1
fi

failures=0
declare -a fail_ids=()

record() {
  local id="$1"
  local rc="$2"
  if [ "$rc" -eq 0 ]; then
    printf '[gate] PASS %s\n' "$id"
  else
    printf '[gate] FAIL %s\n' "$id"
    failures=$((failures + 1))
    fail_ids+=("$id")
  fi
}

step() {
  printf '\n=== %s ===\n' "$*"
}

# ---------------------------------------------------------------------
# VAL-CROSS-001..003 + VAL-CROSS-008 — combined build/typecheck/test sweep
# under a 10-minute wall-clock budget.
# ---------------------------------------------------------------------
step "VAL-CROSS-001..003 + VAL-CROSS-008 — test-all.sh under 600s"
sweep_log="$(mktemp -t mcp-gate-sweep-XXXXXX.log)"
sweep_start=$(date +%s)
bash mission-scripts/test-all.sh >"$sweep_log" 2>&1
sweep_rc=$?
sweep_elapsed=$(( $(date +%s) - sweep_start ))
echo "[gate] test-all.sh: rc=$sweep_rc elapsed=${sweep_elapsed}s log=$sweep_log"
tail -30 "$sweep_log" || true

# VAL-CROSS-001 + VAL-CROSS-002 + VAL-CROSS-003 are jointly true iff every
# connector's build + typecheck + test passed inside test-all.sh.
record VAL-CROSS-001 "$sweep_rc"
record VAL-CROSS-002 "$sweep_rc"
record VAL-CROSS-003 "$sweep_rc"

# VAL-CROSS-008: wall-clock <= 600s AND exit 0.
if [ "$sweep_rc" -eq 0 ] && [ "$sweep_elapsed" -le 600 ]; then
  record VAL-CROSS-008 0
else
  record VAL-CROSS-008 1
fi

# ---------------------------------------------------------------------
# VAL-CROSS-004 — test-harness builds and tests pass
# ---------------------------------------------------------------------
step "VAL-CROSS-004 — test-harness build + tests"
harness_log="$(mktemp -t mcp-gate-harness-XXXXXX.log)"
(
  cd test-harness
  npm run build && npx --no-install vitest run --passWithNoTests
) >"$harness_log" 2>&1
harness_rc=$?
tail -20 "$harness_log" || true
record VAL-CROSS-004 "$harness_rc"

# ---------------------------------------------------------------------
# VAL-CROSS-005 — actionlint passes on every workflow
# ---------------------------------------------------------------------
step "VAL-CROSS-005 — actionlint"
actionlint_out="$(mktemp -t mcp-gate-actionlint-XXXXXX.log)"
actionlint .github/workflows/ci.yml \
           .github/workflows/pr-notify.yml \
           .github/workflows/publish.yml >"$actionlint_out" 2>&1
actionlint_rc=$?
if [ -s "$actionlint_out" ]; then cat "$actionlint_out"; fi
record VAL-CROSS-005 "$actionlint_rc"

# ---------------------------------------------------------------------
# VAL-CROSS-006 — secret scan
# ---------------------------------------------------------------------
step "VAL-CROSS-006 — repo-wide secret scan"
hits="$(rg -n --no-heading \
  -e 'sk_live_[A-Za-z0-9]{16,}' \
  -e 'xoxb-[A-Za-z0-9-]{10,}' \
  -e 'ghp_[A-Za-z0-9]{20,}' \
  -e 'AKIA[A-Z0-9]{16}' \
  -e '"private_key":\s*"-----BEGIN' \
  -g '!**/node_modules/**' \
  -g '!**/dist/**' \
  -g '!**/.git/**' \
  -g '!**/coverage/**' \
  . || true)"
if [ -z "$hits" ]; then
  record VAL-CROSS-006 0
else
  echo "$hits"
  record VAL-CROSS-006 1
fi

# ---------------------------------------------------------------------
# VAL-CROSS-007 — no .env / .env.* tracked + .gitignore covers required patterns
# ---------------------------------------------------------------------
step "VAL-CROSS-007 — .env tracked-files + .gitignore patterns"
# NOTE: rg in this env (15.x) treats -E as --encoding; pass the regex
# directly. Default rg syntax already supports the alternations we need.
env_tracked="$(git ls-files | rg '(^|/)\.env(\.|$)' || true)"
gitignore_rc=0
for pat in '*.pem' '*.key' '*.p12' '*.pfx' '*.crt' 'id_rsa' 'id_rsa.*' '*.token.json' 'credentials/'; do
  if ! grep -qxF "$pat" .gitignore; then
    echo "[gate]   GITIGNORE-MISS: $pat"
    gitignore_rc=1
  fi
done
if [ -z "$env_tracked" ] && [ "$gitignore_rc" -eq 0 ]; then
  record VAL-CROSS-007 0
else
  if [ -n "$env_tracked" ]; then
    echo "[gate]   tracked .env files detected:"
    echo "$env_tracked"
  fi
  record VAL-CROSS-007 1
fi

# ---------------------------------------------------------------------
# VAL-CROSS-009 — every connector registers > 0 tools
# ---------------------------------------------------------------------
step "VAL-CROSS-009 — server.tool / server.registerTool count > 0 per connector"
tools_rc=0
for c in "${CONNECTORS[@]}"; do
  count=$(rg -c 'server\.tool\(|server\.registerTool\(' "connectors/$c/src/" 2>/dev/null \
            | awk -F: '{s+=$2} END {print s+0}')
  if [ "${count:-0}" -le 0 ]; then
    echo "[gate]   TOOLS-MISSING: $c"
    tools_rc=1
  else
    printf '[gate]   %-22s tools=%s\n' "$c" "$count"
  fi
done
record VAL-CROSS-009 "$tools_rc"

# ---------------------------------------------------------------------
# VAL-CROSS-010 — QuickBooks breaking-change documented + version bumped
# ---------------------------------------------------------------------
step "VAL-CROSS-010 — QuickBooks docs + version"
qb_rc=0
rg -q 'QB_ALLOW_PROD_WRITES' connectors/quickbooks/README.md \
  || { echo "[gate]   QB README missing QB_ALLOW_PROD_WRITES"; qb_rc=1; }
rg -q -i '##.*(breaking|prod.write|secure.by.default)' connectors/quickbooks/README.md \
  || { echo "[gate]   QB README missing breaking-change heading"; qb_rc=1; }
ver=$(jq -r '.version' connectors/quickbooks/package.json)
case "$ver" in
  ''|0.2.1) echo "[gate]   QB version not bumped: $ver"; qb_rc=1 ;;
esac
node -e 'const v=process.argv[1].split(".").map(Number); const b=[0,2,1]; process.exit((v[0]>b[0]||(v[0]===b[0]&&v[1]>b[1])) ? 0 : 1);' "$ver" \
  || { echo "[gate]   QB minor not strictly above 0.2.x: $ver"; qb_rc=1; }
record VAL-CROSS-010 "$qb_rc"

# ---------------------------------------------------------------------
# VAL-MISC-901 — focused regression over the M3.6..M3.13 connectors
# ---------------------------------------------------------------------
step "VAL-MISC-901 — M3.6..M3.13 subset build+typecheck+test"
misc_rc=0
for c in nano-banana pandadoc mixmax elevenlabs retell-ai apple-shortcuts browser-automation quickbooks; do
  one_log="$(mktemp -t mcp-gate-misc-$c-XXXXXX.log)"
  (
    cd "connectors/$c" \
    && npm run build --silent \
    && npx --no-install tsc --noEmit \
    && npm test --silent
  ) >"$one_log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[gate]   MISC-901-FAIL $c (rc=$rc, log=$one_log)"
    tail -20 "$one_log"
    misc_rc=1
  else
    echo "[gate]   MISC-901-PASS $c"
  fi
done
record VAL-MISC-901 "$misc_rc"

# ---------------------------------------------------------------------
# VAL-MISC-902 — test-harness build + vitest stays green
# ---------------------------------------------------------------------
step "VAL-MISC-902 — test-harness build + vitest"
harness902_log="$(mktemp -t mcp-gate-misc902-XXXXXX.log)"
(
  cd test-harness \
  && npm run build \
  && npx --no-install vitest run --passWithNoTests
) >"$harness902_log" 2>&1
harness902_rc=$?
if [ "$harness902_rc" -ne 0 ]; then tail -20 "$harness902_log"; fi
record VAL-MISC-902 "$harness902_rc"

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
echo
echo "=== regression-gate summary ==="
echo "[gate] failures=$failures"
if [ "$failures" -ne 0 ]; then
  printf '[gate] failed_ids:'
  for id in "${fail_ids[@]}"; do printf ' %s' "$id"; done
  printf '\n'
fi

exit "$failures"
