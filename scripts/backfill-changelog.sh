#!/usr/bin/env bash
#
# scripts/backfill-changelog.sh
#
# LOCAL-ONLY one-shot generator that reconstructs per-connector CHANGELOG.md
# files from git history during the @mindstone-engineering -> @mindstone npm
# scope migration.
#
# Threat model:
#   This script downloads a pinned git-cliff release binary (verified by
#   SHA-256) and runs it on a maintainer workstation. It MUST NOT be invoked
#   from any GitHub workflow. The release pipeline (publish.yml) executes no
#   code-generation tooling by design -- see
#   docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md (R12, R13, R15).
#
# Usage:
#   scripts/backfill-changelog.sh                    # all connectors w/o CHANGELOG
#   scripts/backfill-changelog.sh retell-ai office   # subset, explicit
#   FORCE=1 scripts/backfill-changelog.sh retell-ai  # overwrite existing
#
# When invoked with no arguments, the script SKIPS any connector that already
# has a hand-authored CHANGELOG.md. Passing connector names explicitly opts
# them in regardless; setting FORCE=1 allows overwriting an existing file
# (the previous content is left in the git index for review).
#
# The script is idempotent. Running it twice produces the same output (modulo
# new commits) and never mutates remote state -- the synthetic tags it creates
# are deleted before the script exits, even on failure.

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Paths and pinned git-cliff binary
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

GIT_CLIFF_VERSION="2.13.1"
CACHE_DIR="$REPO_ROOT/.cache/git-cliff"
EXTRACT_DIR="$CACHE_DIR/git-cliff-${GIT_CLIFF_VERSION}"
BIN="$EXTRACT_DIR/git-cliff"
CONFIG="$SCRIPT_DIR/cliff.toml"

case "$(uname -sm)" in
  "Darwin arm64")
    ASSET="git-cliff-${GIT_CLIFF_VERSION}-aarch64-apple-darwin.tar.gz"
    EXPECTED_SHA256="21547ae4a0421164070ab75c2522864ea5565858a011fabc5f583061b20f1226"
    ;;
  "Darwin x86_64")
    ASSET="git-cliff-${GIT_CLIFF_VERSION}-x86_64-apple-darwin.tar.gz"
    EXPECTED_SHA256=""  # add a pinned hash here before first invocation on Intel macOS
    ;;
  "Linux x86_64")
    ASSET="git-cliff-${GIT_CLIFF_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
    EXPECTED_SHA256=""  # add a pinned hash here before first invocation on Linux
    ;;
  *)
    echo "[backfill-changelog] unsupported platform: $(uname -sm)" >&2
    exit 1
    ;;
esac

if [ -z "${EXPECTED_SHA256:-}" ]; then
  echo "[backfill-changelog] platform $(uname -sm) has no pinned SHA-256 yet." >&2
  echo "[backfill-changelog] Download the tarball manually, verify against the" >&2
  echo "[backfill-changelog] orhun/git-cliff signed sha512 file, and record the" >&2
  echo "[backfill-changelog] sha256 in this script before re-running." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Fetch + verify git-cliff (cached after first run)
# ---------------------------------------------------------------------------

if [ ! -x "$BIN" ]; then
  echo "[backfill-changelog] downloading git-cliff $GIT_CLIFF_VERSION..."
  mkdir -p "$CACHE_DIR"
  TARBALL="$CACHE_DIR/$ASSET"

  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/orhun/git-cliff/releases/download/v${GIT_CLIFF_VERSION}/${ASSET}" \
    -o "$TARBALL"

  ACTUAL_SHA256=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
  if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "[backfill-changelog] SHA-256 verification FAILED for $ASSET" >&2
    echo "  expected: $EXPECTED_SHA256" >&2
    echo "  actual:   $ACTUAL_SHA256" >&2
    rm -f "$TARBALL"
    exit 1
  fi

  rm -rf "$EXTRACT_DIR"
  tar -xzf "$TARBALL" -C "$CACHE_DIR"
fi

if [ ! -f "$CONFIG" ]; then
  echo "[backfill-changelog] config not found: $CONFIG" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Helpers
# ---------------------------------------------------------------------------

# Print "<sha>|<version>" for each commit that introduced a new package.json
# version on the connector's pinned path. The output is in oldest-first order
# and deduplicated on version (the first commit to carry version X wins).
synthesize_version_history() {
  local connector="$1"
  local pkg="connectors/${connector}/package.json"

  git log --reverse --format='%H' -- "$pkg" \
    | while read -r sha; do
        local version
        version=$(git show "${sha}:${pkg}" 2>/dev/null \
          | python3 -c "import json,sys
try:
    print(json.load(sys.stdin).get('version',''))
except Exception:
    pass" 2>/dev/null || true)
        [ -z "$version" ] && continue
        printf '%s|%s\n' "$sha" "$version"
      done \
    | awk -F'|' '!seen[$2]++ {print}'
}

cleanup_synthetic_tags() {
  local connector="$1"
  local tags
  tags=$(git tag --list "__cliff/${connector}-v*" 2>/dev/null || true)
  if [ -n "$tags" ]; then
    while IFS= read -r tag; do
      [ -n "$tag" ] && git tag -d "$tag" >/dev/null 2>&1 || true
    done <<<"$tags"
  fi
}

# Trap to clean up on any exit so we never leave the working tree polluted
# with synthetic refs.
CURRENT_CONNECTOR=""
on_exit() {
  if [ -n "$CURRENT_CONNECTOR" ]; then
    cleanup_synthetic_tags "$CURRENT_CONNECTOR"
  fi
}
trap on_exit EXIT INT TERM

# ---------------------------------------------------------------------------
# 4. Determine target set
# ---------------------------------------------------------------------------

EXPLICIT_TARGETS=0
CONNECTORS=()
if [ "$#" -gt 0 ]; then
  EXPLICIT_TARGETS=1
  CONNECTORS=("$@")
else
  for d in "$REPO_ROOT"/connectors/*/; do
    c=$(basename "$d")
    [ "$c" = "_template" ] && continue
    CONNECTORS+=("$c")
  done
fi

# ---------------------------------------------------------------------------
# 5. Generate
# ---------------------------------------------------------------------------

for connector in "${CONNECTORS[@]}"; do
  out="connectors/${connector}/CHANGELOG.md"
  if [ -f "$out" ] && [ "$EXPLICIT_TARGETS" -eq 0 ] && [ "${FORCE:-0}" != "1" ]; then
    echo "===> $connector  [skipped: CHANGELOG.md already exists]"
    continue
  fi
  if [ -f "$out" ] && [ "${FORCE:-0}" != "1" ] && [ "$EXPLICIT_TARGETS" -eq 1 ]; then
    echo "===> $connector  [skipped: CHANGELOG.md exists; re-run with FORCE=1 to overwrite]"
    continue
  fi

  echo "===> $connector"
  CURRENT_CONNECTOR="$connector"
  cleanup_synthetic_tags "$connector"

  history=$(synthesize_version_history "$connector" || true)
  if [ -z "$history" ]; then
    echo "  no package.json version history; skipping"
    CURRENT_CONNECTOR=""
    continue
  fi

  while IFS='|' read -r sha version; do
    [ -z "$sha" ] && continue
    [ -z "$version" ] && continue
    git tag "__cliff/${connector}-v${version}" "$sha" >/dev/null
  done <<<"$history"

  "$BIN" \
    --config "$CONFIG" \
    --tag-pattern "^__cliff/${connector}-v[0-9]+\\.[0-9]+\\.[0-9]+$" \
    --include-path "connectors/${connector}/**" \
    --output "$out"

  # The tera template renders versions as the raw tag name; strip the
  # synthetic prefix so the file reads `## [0.2.0]` instead of
  # `## [__cliff/retell-ai-v0.2.0]`.
  python3 - "$out" "$connector" <<'PY'
import re, sys, pathlib
path, connector = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
text = re.sub(rf"__cliff/{re.escape(connector)}-v", "", text)
path.write_text(text)
PY

  cleanup_synthetic_tags "$connector"
  CURRENT_CONNECTOR=""
done

echo ""
echo "[backfill-changelog] done. Review the generated CHANGELOG.md files,"
echo "then commit them as the 'CHANGELOG backfill' step of the scope migration."
