# Branch & Tag Protection — chosen posture

**Status:** Documents the *chosen, actual* posture (updated 2026-06-11). Earlier revisions of this file described a much stricter aspirational posture (PR-required, enforce-admins, signed commits, push restrictions) that was never applied and had drifted badly from reality in both directions — stricter than reality on branch protection, behind reality on CI publishing existing at all. This revision documents what is deliberately configured and why, so settings drift stays visible and honest.
**Audience:** Repo administrators on `mindstone/mcp-servers`.

These settings live in GitHub UI / API, not in repo files. When you change a setting, change this document in the same sitting.

## 0. The posture in one paragraph

`main` accepts **direct pushes from maintainers and the release tooling** — this is deliberate (decision 2026-06-09, reaffirmed 2026-06-11: the team is small and the release flow is script-driven from the Rebel repo). PRs are gated by **required status checks** (the version-bump guard workflow is live, live-tested, and registered as a required check as of 2026-06-11 — a PR can never become a publish trigger). Publishes are gated **by construction, not by humans**: `release.yml` refuses any version bump whose release commit lacks a `Release-Gate` trailer, the `npm-publish` environment has **no required reviewers by design** under the AI-only release policy, and every publish posts a Slack alert. The full gate chain is in [`docs/PUBLISH_APPROVAL_PROCESS.md`](../PUBLISH_APPROVAL_PROCESS.md).

## 1. Branch protection — `main` (classic rule)

Configured under `Settings → Branches` (classic branch protection; ruleset migration deferred, see §6).

| Setting | Chosen value | Rationale |
|---|---|---|
| Require a pull request before merging | **Off** | Direct push by maintainers + release tooling is the working model. PRs remain the preferred path for non-trivial and external changes, but are not forced. |
| Required approving reviews | **None enforced** | Two-maintainer team; review happens via the AI-only review chain (cross-family adversarial review on releases; CHIEF_ENGINEER-style review on Rebel-side work), not via GitHub review clicks. |
| Require status checks to pass | **On** — currently registered: `build-and-test`, `validate` (server.json check), `connector version bumps require a CHANGELOG entry` (changelog-check), the STATUS/catalogue drift checks, `connector version bumps land only via release tooling` (the version-bump guard; live-tested — it blocked verification PR #90), and `server.json registry validation` (registry round-trip; given a distinct check-run name 2026-06-11 to disambiguate from CI's `validate` job). Both registered as required 2026-06-11. | Blocks PR merges on CI fail. A PR merge is mechanically blocked by the version-bump guard and the registry validation. (Defense in depth: even if a bump somehow merged, `release.yml`'s trailer gate refuses to publish it.) |
| Require branches to be up to date before merging | **On** (strict checks) | Closes the merge-train substitution gap; re-runs the drift checks against current `main` before merge. |
| Include administrators (enforce_admins) | **Off** | Consequence of the direct-push model. Admin pushes bypass the PR checks; the publish path is protected separately by the trailer gate, which direct pushes cannot bypass. |
| Restrict who can push | **Not set** (org membership is the effective restriction) | Acceptable at current team size; revisit at OSS-launch review. |
| Allow force pushes | **Off** | Mandatory. |
| Allow deletions | **Off** | Mandatory. |
| Require signed commits | **Off — DEFERRED hardening** | Would add an out-of-band-credential property on top of the trailer gate (a compromised GitHub session could not forge a publishable release commit). Deferred for key-management overhead at current team size. **Re-open signals:** external-contributor volume growth, any credential-compromise scare, OSS-launch readiness review. |

What this posture accepts, honestly: a maintainer (or anyone compromising a maintainer account) can push code to `main` without review, and the required checks run *after* the push (detection, not prevention). What it does **not** accept: that push becoming an npm publish — a version bump without a valid `Release-Gate` trailer fails `release.yml` loudly and publishes nothing, and a bump inside a PR fails the version-bump guard before merge.

## 2. Tag protection — `*-v*`

Configure under `Settings → Tags → Add rule`. Tags are cut for archival / changelog purposes; they trigger no publish (`release.yml` triggers on push to `main`, never on tags).

| Setting | Required value |
|---|---|
| Pattern | `*-v*` |
| Restrict who can push tags | **`@mindstone/oss-maintainers` team only** |

## 3. npm-publish GitHub Actions environment

The `npm-publish` environment **exists** and is required by `release.yml`'s `publish-npm` job (it is part of npm's Trusted Publishing trust configuration).

- **Required reviewers: none — BY DESIGN.** Under the AI-only release policy (decision 2026-06-11), publish approval is machine-validated: §13 AI security review with a cross-family adversarial pass, the `Release-Gate` trailer gate in `release.yml`, the Rebel-side trailer audit, and per-publish Slack alerting. See [`docs/PUBLISH_APPROVAL_PROCESS.md`](../PUBLISH_APPROVAL_PROCESS.md) for the full chain and for what the model does and does not claim.
- Adding a required reviewer to this environment is a **policy change**, not a hardening tweak — it reintroduces a human bottleneck the team explicitly removed. Do not add one without revisiting that decision.
- No `NPM_TOKEN` or other npm credential exists in this environment (or anywhere in the repo). Trusted Publishing OIDC is the only auth path.

## 4. npm-side configuration (out of repo, but required)

- Every published `@mindstone/mcp-server-*` package has Trusted Publishing configured, bound to `mindstone/mcp-servers` + `.github/workflows/release.yml`. First publishes are manual and WebAuthn-gated (see PUBLISH_APPROVAL_PROCESS § First publishes).
- The publisher account (`mindstone-engineering`) has WebAuthn-only 2FA for the manual bootstrap path and destructive admin commands.
- No automation tokens on the `@mindstone/` scope (`npm token list`). Their existence is a red flag — revoke and investigate.
- The repo-root `.npmrc` pins `min-release-age=7` (security invariant #1 in `AGENTS.md`); consumers with that setting get a 7-day recall window.

## 5. Verification (post-config)

```bash
# Required status checks on main include the two PR gates
gh api repos/mindstone/mcp-servers/branches/main/protection \
  --jq '.required_status_checks.contexts'
# expect: includes build-and-test, validate, the changelog check, and the
# STATUS/catalogue drift checks + version-bump guard + server.json registry validation.
# registration (see §1) — once added, expect it here too

# PRs are NOT required (chosen posture) — direct push is allowed
gh api repos/mindstone/mcp-servers/branches/main/protection \
  --jq '.required_pull_request_reviews // "none (by design)"'

# npm-publish environment exists with no required reviewers (by design)
gh api repos/mindstone/mcp-servers/environments/npm-publish \
  --jq '{reviewers: (.protection_rules // []) | map(select(.type == "required_reviewers"))}'
# expect: reviewers == []

# Tag protection in place
gh api repos/mindstone/mcp-servers/tags/protection --jq '.[].pattern'
# expect: "*-v*"

# No npm automation token in Actions secrets
gh secret list --repo mindstone/mcp-servers \
  | awk '$1 == "NPM_TOKEN" { print "PRESENT" }'
# expect: (empty)

# Recent release commits carry the Release-Gate trailer
git log --grep='^Release-Gate: ' --oneline -5
```

## 6. Ruleset migration — DEFERRED

The OpenSSF Scorecard `Branch-Protection` check reports `-1` because the default `GITHUB_TOKEN` cannot read **classic** branch protection; migrating the `main` rule to a repository ruleset (Settings → Rules → Rulesets) would fix the score with no behavior change. Deferred as a pure score fix. **Re-open signals:** OSS-launch readiness review, or the next time branch protection is edited anyway and the marginal cost is ~zero. When migrating, translate §1 above 1:1 to ruleset toggles and only delete the classic rule after `gh api repos/mindstone/mcp-servers/rules/branches/main` confirms the ruleset is active.
