#!/usr/bin/env bash
# Verify the published artefact contains no bridge/callback server strings.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$PKG_ROOT/dist"

# Patterns that must NEVER appear in the published artefact.
PATTERNS=(
  "MINDSTONE_REBEL_BRIDGE_STATE"
  "MCP_HOST_BRIDGE_STATE"
  "callback-server"
  "OAuthCallbackServer"
  "http.createServer"
  "Mindstone"
  "Rebel"
  "nspr"
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
# 2. Scan dist/ inside the packed tarball (the runtime artifact users execute).
# ---------------------------------------------------------------------------
if [[ -d "$DIST" && "${HUBSPOT_SKIP_BRIDGE_TARBALL_SCAN:-}" != "1" ]]; then
  TMP_PACK_DIR="$(mktemp -d -t hubspot-mcp-bridge-scan-XXXXXX)"
  trap 'rm -rf "$TMP_PACK_DIR"' EXIT

  echo "[check-no-bridge-strings] Packing tarball into $TMP_PACK_DIR for scan…" >&2
  if ! (
    cd "$PKG_ROOT" \
      && HUBSPOT_SKIP_BRIDGE_TARBALL_SCAN=1 npm pack --pack-destination "$TMP_PACK_DIR" --silent --ignore-scripts >/dev/null
  ); then
    echo "[check-no-bridge-strings] FAIL: npm pack failed; cannot scan tarball." >&2
    exit 1
  fi

  # Find the produced tarball (npm pack writes one .tgz file).
  TARBALL="$(find "$TMP_PACK_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [[ -z "$TARBALL" ]]; then
    echo "[check-no-bridge-strings] FAIL: no tarball produced in $TMP_PACK_DIR." >&2
    exit 1
  fi
  echo "[check-no-bridge-strings] Scanning dist/ inside tarball: $TARBALL" >&2

  if ! tar -xzf "$TARBALL" -C "$TMP_PACK_DIR" 2>/dev/null; then
    echo "[check-no-bridge-strings] FAIL: failed to extract tarball for scan." >&2
    exit 1
  fi

  TARBALL_DIST="$TMP_PACK_DIR/package/dist"
  if [[ ! -d "$TARBALL_DIST" ]]; then
    echo "[check-no-bridge-strings] FAIL: packed tarball missing package/dist." >&2
    exit 1
  fi

  for pattern in "${PATTERNS[@]}"; do
    if matches=$(grep -rn -F "$pattern" "$TARBALL_DIST" 2>/dev/null); then
      echo "[check-no-bridge-strings] FAIL (tarball dist/): pattern '$pattern' found in packed tarball dist/:" >&2
      echo "$matches" >&2
      found_any=1
    fi
  done
elif [[ "${HUBSPOT_SKIP_BRIDGE_TARBALL_SCAN:-}" == "1" ]]; then
  echo "[check-no-bridge-strings] Skipping nested tarball scan during npm pack prepare." >&2
fi

if [[ $found_any -ne 0 ]]; then
  echo "[check-no-bridge-strings] Bridge-state / host-internal strings detected in published artefact." >&2
  echo "[check-no-bridge-strings] These must not ship in the OSS package." >&2
  exit 1
fi

echo "[check-no-bridge-strings] OK — no bridge-state strings in dist/ or packed tarball."
