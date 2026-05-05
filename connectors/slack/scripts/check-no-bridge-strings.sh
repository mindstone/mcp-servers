#!/usr/bin/env bash
# Verify the published artefact contains no host-internal bridge strings.
#
# Per Decision Q1 → Option A in docs/plans/260429_slack_mcp_oss_migration.md,
# the OSS server must NOT carry "MINDSTONE_REBEL_BRIDGE_STATE" /
# "MCP_HOST_BRIDGE_STATE" or any /bundled/ HTTP paths — those are host-side
# vocabulary that publishing exposes (failure class 1, VAL-OUTREACH-006).
#
# Scans BOTH:
#   1. dist/    — every compiled .js shipped via the `files` allowlist.
#   2. The packed tarball (`npm pack`) — catches anything else npm includes
#      regardless of the `files` config (README.md, package.json, LICENSE,
#      CHANGELOG.md…). This closes the gap where a bridge string in README
#      would ship to npm even though dist/ is clean.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$PKG_ROOT/dist"

# Patterns that must NEVER appear in the published artefact.
PATTERNS=(
  "MINDSTONE_REBEL_BRIDGE_STATE"
  "MCP_HOST_BRIDGE_STATE"
  "/bundled/slack/start-auth"
  "/bundled/"
  "loadBridgeState"
  "bridgeRequest"
)

found_any=0

# ---------------------------------------------------------------------------
# 1. Scan dist/ for bridge strings.
# ---------------------------------------------------------------------------
if [[ -d "$DIST" ]]; then
  for pattern in "${PATTERNS[@]}"; do
    # grep -r returns 1 if no match — so don't fail the whole script on no-match.
    if matches=$(grep -rn -F "$pattern" "$DIST" 2>/dev/null); then
      echo "[check-no-bridge-strings] FAIL (dist/): pattern '$pattern' found in dist:" >&2
      echo "$matches" >&2
      found_any=1
    fi
  done
else
  echo "[check-no-bridge-strings] dist/ not built yet — skipping dist scan (run 'tsc' first)." >&2
fi

# ---------------------------------------------------------------------------
# 2. Scan the packed tarball — catches files outside dist/ that npm ships
#    regardless of `files` config (README.md, LICENSE, package.json…).
# ---------------------------------------------------------------------------
if [[ -d "$DIST" ]]; then
  TMP_PACK_DIR="$(mktemp -d -t slack-mcp-bridge-scan-XXXXXX)"
  trap 'rm -rf "$TMP_PACK_DIR"' EXIT

  echo "[check-no-bridge-strings] Packing tarball into $TMP_PACK_DIR for scan…" >&2
  if ! ( cd "$PKG_ROOT" && npm pack --pack-destination "$TMP_PACK_DIR" --silent --ignore-scripts >/dev/null ); then
    echo "[check-no-bridge-strings] FAIL: npm pack failed; cannot scan tarball." >&2
    exit 1
  fi

  # Find the produced tarball (npm pack writes one .tgz file).
  TARBALL="$(find "$TMP_PACK_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [[ -z "$TARBALL" ]]; then
    echo "[check-no-bridge-strings] FAIL: no tarball produced in $TMP_PACK_DIR." >&2
    exit 1
  fi
  echo "[check-no-bridge-strings] Scanning tarball: $TARBALL" >&2

  # Extract every file's contents to stdout and grep for each pattern.
  # `tar -xzOf -` outputs every file content concatenated, which is fine
  # because any match anywhere in the tarball must fail the gate.
  TARBALL_DUMP_FILE="$TMP_PACK_DIR/dump.txt"
  if ! tar -xzOf "$TARBALL" >"$TARBALL_DUMP_FILE" 2>/dev/null; then
    echo "[check-no-bridge-strings] FAIL: failed to extract tarball for scan." >&2
    exit 1
  fi

  for pattern in "${PATTERNS[@]}"; do
    if matches=$(grep -F -n "$pattern" "$TARBALL_DUMP_FILE" 2>/dev/null); then
      echo "[check-no-bridge-strings] FAIL (tarball): pattern '$pattern' found in packed tarball:" >&2
      echo "$matches" | head -20 >&2
      found_any=1
    fi
  done
fi

if [[ $found_any -ne 0 ]]; then
  echo "[check-no-bridge-strings] Bridge-state / host-internal strings detected in published artefact." >&2
  echo "[check-no-bridge-strings] These must not ship in the OSS package." >&2
  exit 1
fi

echo "[check-no-bridge-strings] OK — no bridge-state strings in dist/ or packed tarball."
