# Generated-artifact drift on `main` — prevention options

**Date:** 2026-06-09
**Context:** `main` CI was red for 11+ days, firing recurring Slack `:red_circle: mcp-servers CI failed on main` alerts. Fixed in PR #82 (`30b1e6a`). This doc captures *why it recurs* and the options for preventing it, so the structural decisions can be made deliberately rather than re-derived each time.

## The problem

Several files are **generated from source but committed to git**, then policed by CI `--check` jobs:

| Surface | Generator | Checked by | Served/consumed |
|---|---|---|---|
| `docs/catalogue/<name>.md`, `docs/index.md` | `scripts/build-catalogue.mjs` | `catalogue-check` (CI) + `pages.yml` | GitHub Pages site (Jekyll, `source: ./docs`) |
| `INSTALL_LINKS` block in each `connectors/<name>/README.md` | `scripts/gen-install-links.mjs` | `install-links-check` (CI) | GitHub + npm README |
| `connectors/<name>/STATUS.json` (`version`, `tools.count`) | hand-authored; `scripts/init-status.mjs` scaffolds | `check-status.mjs` per-connector matrix (CI) | catalogue generator input |

Every committed-but-derived artifact is a **drift surface**: it can fall out of sync with its source, and we need a checker to police it. The recurring failure is just drift reaching `main`.

**Root cause of recurrence:** connector releases are committed **directly to `main` with no PR** (verified via the commits API). The required status checks only gate *PRs*; a direct push runs them *after* the commit is already on `main` (detection, not prevention), and `enforce_admins: false` means admins aren't blocked. The documented release ritual (AGENTS.md "Version-sync invariant", CONTRIBUTING "Bumping a connector") also **omitted `STATUS.json` and the regeneration step** — so even a careful releaser following the docs would drift. (That doc gap is fixed as of this change.)

### "Just run the checks on push" doesn't prevent it
They already run on `push: [main]` and on `pull_request`. On a direct push to `main`, the check runs *after* the bad commit lands — it can only turn the build red. Prevention requires either gating the merge (PR + required checks + no admin bypass) or moving generation so there's nothing committed to drift.

## Options

| # | Option | Kills which surface | Cost / risk | Status |
|---|---|---|---|---|
| **2** | **Fix the process docs** — add `STATUS.json` to the version-sync invariant; document the regenerate step in CONTRIBUTING + "Adding a connector" | Reduces human-miss rate on all surfaces (not a hard guarantee) | None (docs only) | **DONE (this change)** |
| **1** | **Generate the catalogue at deploy; stop committing it.** Gitignore `docs/index.md` + `docs/catalogue/`; `pages.yml` build job runs `build-catalogue.mjs` before Jekyll; drop `catalogue-check`. | Catalogue drift, **by construction** (nothing committed) | Small, CI-only, reversible. Requires removing `Catalogue is up to date` from `main`'s required status checks (branch-protection edit). Loses PR catalogue-diff preview + GitHub blob view. | **HELD** — see "Why held" |
| **B** | **Auto-regenerate-and-commit on push to `main`.** Workflow runs the generators and commits the result back if anything changed. | Catalogue + install-links + STATUS `version`, **by construction**, while keeping direct-push | Moderate. Needs `contents: write` on a security-hardened repo; push-race + loop guards. **Conflicts with CONTRIBUTING's documented "no auto-generation in CI" stance** (supply-chain attack surface — see `docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md`). Best done in a daylight session with a security review. | **DEFERRED** — this is the mechanism that actually delivers "automatic + invisible + keep direct-push" |
| **4** | **Stop storing derived values in `STATUS.json`.** Drop `version` (derive from package.json) — schemaVersion 1→2 migration across all 37 connectors + `check-status.mjs` + `init-status.mjs` + schema + docs. | STATUS `version`-lag, by construction | Repo-wide schema migration; mechanical but large. (`tools.count` can NOT be cleanly derived — the heuristic can't count factory patterns like xero — so it stays.) | **DEFERRED** (Greg, 2026-06-09: "best long-term thing, but hold off; note as future option") |
| **3** | **`enforce_admins: true`** (+ ideally PR-required) | Makes the *existing* required checks bind everyone, incl. direct pushes | Releases route through PRs instead of direct push to `main`. | **DEFERRED** (Greg, 2026-06-09: wants to keep direct-push for now) |
| — | Local pre-push git hook | partial | Repo has **no root `package.json`** by deliberate design (AGENTS.md: "no root-level workspace orchestration"); husky fights the grain; adoption is voluntary | **REJECTED** |

### Honest scope note
Option 2 (done) + Option 1 (held) together would **not** fully stop the pings: the README install-links check and the STATUS `version` check remain committed/enforced surfaces, and a routine version bump drifts both the catalogue *and* STATUS. After 1+2 a release would fail ~1 job instead of 2 — Slack still pings. The only options that fully eliminate the recurrence while keeping **direct-push** are **B** (auto-commit bot) or **4** (remove the stored value). The option that eliminates it via the repo's *documented* design is **3 + PR-required** (see below).

## Branch-protection drift (surfaced 2026-06-09 — needs a decision)

`docs/security/BRANCH_PROTECTION.md` documents the **intended** posture (FOX-3319, "Required for OSS launch", P1):
- Require a PR before merging — *"No direct pushes to `main`."*
- Required approving reviews ≥ 1 + Code Owner review.
- Include administrators: **On** — *"No bypass for admins."*
- Require signed commits: **On**.
- Restrict who can push: `@mindstone/oss-maintainers` only.
- Required checks: `build-and-test`, `validate`, `changelog-check`.

The **actual** `main` protection today (no ruleset exists; classic protection is live):
- `enforce_admins`: **false** (doc says On)
- `required_pull_request_reviews`: **absent** — PRs not required (doc says required + reviews + code owners)
- `required_signatures`: **false** (doc says On)
- `restrictions` (who can push): **absent** — anyone with write (doc says maintainers-only)
- `required_linear_history`: true ✓ (matches)
- Required checks: `validate`, `Catalogue is up to date`, `One-click install blocks match server.json`, `Discover connectors for status-check`, `connector version bumps require a CHANGELOG entry` (differs from the doc's list)

So the repo is running **well below its own documented OSS-launch security bar**, and the direct-push reality (root cause of this whole problem) is itself drift from documented intent. This is a governance/security call for the repo owner; it should be reconciled regardless of the drift work — either tighten reality up to the doc, or revise the doc to match the chosen reality.

### The strategic fork
- **Direction X (keep direct-push, make it invisible):** build Option B (auto-commit bot). Diverges further from the documented posture and from the "no auto-generation in CI" stance.
- **Direction Y (move to the documented posture):** enforce PR-required + `enforce_admins` (Option 3). The existing required checks then gate every change *before* it lands — the drift problem evaporates with **no new machinery**. This is what BRANCH_PROTECTION.md already mandates for OSS launch; the cost is the PRs Greg currently wants to avoid.

## Recommendation
1. **Done now:** Option 2 (process-doc fixes).
2. **Next (small, needs a 1-line nod):** Option 1 — de-commit the catalogue. Valuable under both directions; held only because it requires editing the (drifted) branch-protection required-checks list, which shouldn't be changed silently.
3. **Decide the direction (X vs Y) awake**, with the branch-protection drift in view. If X: schedule Option B with a security review. If Y: enforcing the documented posture is the cheapest complete fix.

## Why Option 1 is held
De-committing the catalogue requires removing `Catalogue is up to date` from `main`'s required status checks. That branch-protection surface just turned out to be significantly drifted from `docs/security/BRANCH_PROTECTION.md`, so any protection edit should be made deliberately (and ideally as part of reconciling that drift), not as a quiet side effect.
