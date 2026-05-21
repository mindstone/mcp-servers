# Branch & Tag Protection Requirements

**Status:** Required for OSS launch. Tracked under FOX-3319 (P1 R8).
**Audience:** Repo administrators on `mindstone/mcp-servers`.

> **Architecture mode (since FOX-3319 pivot, 2026-05-17):** Publishes happen manually from the wave-lead's dev machine. There is no `.github/workflows/publish.yml` and no `npm-publish` GitHub Actions environment. The branch + tag protection rules below still apply (they gate the version-bump PR that defines what gets published), but section §3 of earlier revisions of this document (npm-publish environment) is superseded.

> **Recommended migration to repository rulesets (2026-05-21):** The OpenSSF Scorecard `Branch-Protection` check currently fails with `internal error: some github tokens can't read classic branch protection rules` because the default `GITHUB_TOKEN` used by `.github/workflows/scorecard.yml` cannot read **classic** branch protection. Migrating the `main` rule to a **repository ruleset** (Settings → Rules → Rulesets) lets the default token read it, flips the Scorecard check from `-1` to a real score, and avoids introducing an admin-scope PAT. The required settings (§1 below) translate 1:1 to ruleset toggles. See §6 for the migration runbook.

These settings live in GitHub UI / API, not in repo files, so they are documented here to keep settings drift visible and reviewable.

## 1. Branch protection — `main`

Configure under `Settings → Branches → Add rule` (or via the Branch Protection API).

| Setting | Required value | Rationale |
|---|---|---|
| Require a pull request before merging | **On** | No direct pushes to `main`. |
| Required approving reviews | **>= 1** (>= 2 once team size allows) | Pair with CODEOWNERS. |
| Dismiss stale approvals on new commits | **On** | Prevents review-then-poison race. |
| Require review from Code Owners | **On** | Enforces `.github/CODEOWNERS`. The `@mindstone/oss-maintainers` team must exist (created 2026-05-17, id 17581413) for this to bite. |
| Require status checks to pass | **On**, must include: `build-and-test`, `validate` (server.json check), `changelog-check` | Blocks merge on CI fail. |
| Require branches to be up to date before merging | **On** | Closes the merge-train substitution gap. |
| Require conversation resolution before merging | **On** | Forces explicit review acknowledgement. |
| Require signed commits | **On** | Closes commit-spoofing on `main`. |
| Require linear history | **On** | Predictable ancestry for any future audit of "which commit produced version X.Y.Z". |
| Include administrators | **On** | No bypass for admins. |
| Restrict who can push | **`@mindstone/oss-maintainers` team only** | Ensures only the named maintainers can land changes that the wave-lead will subsequently `git pull` and publish. |
| Allow force pushes | **Off** | Mandatory. |
| Allow deletions | **Off** | Mandatory. |

## 2. Tag protection — `*-v*`

Configure under `Settings → Tags → Add rule`. Tags are still cut for archival / changelog purposes even though they no longer trigger any CI publish.

| Setting | Required value |
|---|---|
| Pattern | `*-v*` |
| Restrict who can push tags | **`@mindstone/oss-maintainers` team only** |
| Require signed tags | **On** (once tooling supports it) |

## 3. (superseded) npm-publish GitHub Actions environment

This section is intentionally retained as a stub. There is no `npm-publish` environment in the current architecture. If someone proposes reintroducing CI publishing, they must:

1. Re-create `.github/workflows/publish.yml` (or equivalent).
2. Re-create the `npm-publish` environment with required reviewer + tag-policy `*-v*`.
3. Configure per-package Trusted Publisher bindings on npm for all 24 connectors (manually via website UI if the publisher account is WebAuthn-only — see `docs/plans/260517_PHASE_0_IMPLEMENTER_GUIDE.md` in Rebel for the rationale).
4. Update `docs/PUBLISH_APPROVAL_PROCESS.md` to restore the environment-approval step.

Until all four are in place, manual publishes from the wave-lead's dev machine remain the only path. See `docs/PUBLISH_APPROVAL_PROCESS.md` for the human gate that replaces the CI environment reviewer.

## 4. npm-side configuration (out of repo, but required)

- The publisher account (`mindstone-engineering`) must have 2FA enforced. At time of writing this is WebAuthn-only; both publish and the destructive admin commands (`npm token revoke`, `npm access revoke`) require the hardware key.
- A second `@mindstone/` org member should be added before any single-publisher-failure scenario can stall the wave. Open in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`.
- No automation tokens should exist on the `@mindstone/` scope (`npm token list --json | jq '.[] | select(.scope=="@mindstone")'` returns empty). Manual-publish mode does not need them; their existence is a red flag.
- Org-wide: enforce `2FA required for publishing` on every `@mindstone/mcp-server-*` package via npm's package-level settings.

## 5. Verification (post-config)

After applying, the following commands should succeed/return as noted:

```bash
# Branch protection in place
gh api repos/mindstone/mcp-servers/branches/main/protection \
  --jq '.required_pull_request_reviews.require_code_owner_reviews'
# expect: true

# CODEOWNERS team resolves (closed 2026-05-17 as part of the pivot)
gh api orgs/mindstone/teams/oss-maintainers \
  --jq '{name, slug, members_count}'
# expect: name == "oss-maintainers", members_count >= 1

# Tag protection in place
gh api repos/mindstone/mcp-servers/tags/protection \
  --jq '.[].pattern'
# expect: "*-v*"

# No orphan NPM_TOKEN secret
gh secret list --repo mindstone/mcp-servers \
  | awk '$1 == "NPM_TOKEN" { print "PRESENT" }'
# expect: (empty — token should not exist in manual-publish mode)

# No resurrected publish workflow
ls .github/workflows/ | grep -i publish
# expect: (empty)
```

## 6. Migration runbook — classic branch protection → repository ruleset

This unblocks the OpenSSF Scorecard `Branch-Protection` check without
introducing a PAT. Perform on `mindstone/mcp-servers`.

1. **Create the ruleset** at `Settings → Rules → Rulesets → New branch ruleset`.
   - Name: `main protection`.
   - Enforcement status: `Active`.
   - Target branches: `Include default branch`.
   - Bypass list: empty (no bypass for admins, mirrors §1's "Include administrators: On").
2. **Enable rules** so they mirror §1 above:
   - `Restrict deletions`.
   - `Require linear history`.
   - `Require signed commits`.
   - `Require a pull request before merging`:
     - Required approvals: `1` (raise to `2` once team size allows).
     - Dismiss stale pull request approvals when new commits are pushed: `On`.
     - Require review from Code Owners: `On`.
     - Require approval of the most recent reviewable push: `On`.
     - Require conversation resolution before merging: `On`.
   - `Require status checks to pass`:
     - Require branches to be up to date before merging: `On`.
     - Required checks: `build-and-test`, `validate`, `changelog-check`.
   - `Block force pushes`.
3. **Restrict push access** under the ruleset's `Restrict who can push to matching branches` rule:
   - Allow only the `@mindstone/oss-maintainers` team.
4. **Verify the ruleset is read by the default `GITHUB_TOKEN`:**
   ```bash
   gh api repos/mindstone/mcp-servers/rules/branches/main \
     --jq '[.[] | {type, ruleset_source_type}]'
   # expect: a JSON array enumerating each rule above; ruleset_source_type == "Repository".
   ```
5. **Delete the legacy classic branch protection rule** at `Settings → Branches → Branch protection rules → main → Delete`.
   Only do this AFTER step 4 confirms the ruleset is active and complete.
6. **Confirm the next Scorecard run** flips `Branch-Protection` from `-1` to a numeric score:
   - The Scorecard workflow runs on every push to `main` (`.github/workflows/scorecard.yml`); after the next push the badge in `README.md` should reflect the new value.
   - Alternatively, trigger an ad-hoc run: `gh workflow run scorecard.yml --ref main`.

After migration, update §1 of this document to read "Configure under Settings → Rules → Rulesets" and remove the §1 reference to `Settings → Branches → Add rule`. Tag protection (§2) stays in the `Settings → Tags` UI; tag rulesets are a separate ruleset target if desired.
