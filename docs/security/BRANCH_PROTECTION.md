# Branch & Tag Protection — chosen posture

**Status:** Documents the *chosen, actual* posture (updated 2026-11-04). Earlier revisions of this file described a much stricter aspirational posture (PR-required, enforce-admins, signed commits, push restrictions) that was never applied and had drifted badly from reality in both directions — stricter than reality on branch protection, behind reality on CI publishing existing at all. This revision documents what is deliberately configured and why, so settings drift stays visible and honest.
**Audience:** Repo administrators on `mindstone/mcp-servers`.

These settings live in GitHub UI / API, not in repo files. When you change a setting, change this document in the same sitting.

## 0. The posture in one paragraph

`main` takes changes **only by pull request, for everyone, admins included**, and no human approval is needed: review happens while the code is written. The owner, 2026-11-04: "A Okay, let's do the PRs plus a required secret scan." This replaces the direct-push model of June. PRs are gated by **required status checks**, including a secret scan and the version-bump guard (a PR can never become a publish trigger). Publishes are gated **by construction, not by humans**: `release.yml` refuses any version bump whose release commit lacks a `Release-Gate` trailer, the `npm-publish` environment has **no required reviewers by design** under the AI-only release policy, and every publish posts a Slack alert. The full gate chain is in [`docs/PUBLISH_APPROVAL_PROCESS.md`](../PUBLISH_APPROVAL_PROCESS.md).

## 1. Branch protection — `main` (ruleset)

Configured under `Settings → Rules → Rulesets`, in the ruleset `main: pull requests and secret scan`. There is no classic branch protection rule: a deploy key cannot bypass one, and the export below needs that.

| Setting | Chosen value | Rationale |
|---|---|---|
| Require a pull request before merging | **On** | The owner's decision, 2026-11-04. |
| Required approving reviews | **0** | Review happens while the code is written, through the AI review chain (cross-family adversarial review on releases; CHIEF_ENGINEER-style review on Rebel-side work), not through GitHub review clicks. |
| Allowed merge methods | **Merge, squash, rebase** | `mcp:release` and the fleet's merge both use merge commits. |
| Require status checks to pass | **On**, from GitHub Actions only: `secret-scan`, `Catalogue is up to date`, `One-click install blocks match server.json`, `Discover connectors for status-check`, `server.json registry validation`, `package version bumps require a CHANGELOG entry`, `package version bumps land only via release tooling` | Blocks a merge on a failed check. All six older checks passed on 25 of 25 recently merged PRs, releases included, before they became binding for admins. |
| Require branches to be up to date before merging | **On** (strict checks) | Closes the merge-train substitution gap; re-runs the drift checks against current `main` before merge. |
| Bypass list | **Empty** until the export is armed (§6) | A bypass for the admin role would let every session on an admin account push straight past the rule. |
| Require linear history | **Off. Do not add it back.** | With no bypass it would refuse every merge commit. The old classic rule only appeared to work because admins bypassed it. |
| Allow force pushes | **Off** | Mandatory. |
| Allow deletions | **Off** | Mandatory. |
| Require signed commits | **Off — DEFERRED hardening** | Would add an out-of-band-credential property on top of the trailer gate (a compromised GitHub session could not forge a publishable release commit). Deferred for key-management overhead at current team size. **Re-open signals:** external-contributor volume growth, any credential-compromise scare, OSS-launch readiness review. |

What this posture accepts, honestly: a pull request can edit the workflow of a check it must pass, because `pull_request` runs the pull request's copy, and anyone with write access can merge their own pull request once it is green. The checks catch accidents, not someone determined; the publish path stays protected separately by the trailer gate.

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
# The rules that apply to main, by type: expect pull_request and
# required_status_checks, with deletion and non_fast_forward
gh api repos/mindstone/mcp-servers/rules/branches/main --jq '.[].type'

# The required checks: expect secret-scan and the six in §1
gh api repos/mindstone/mcp-servers/rules/branches/main \
  --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'

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

## 6. Emergencies, and the export's key

**In an emergency**, a repository admin turns the ruleset off, does what is needed, and turns it straight back on. Find the ruleset's id with `gh api repos/mindstone/mcp-servers/rulesets`, then:

```bash
gh api -X PUT repos/mindstone/mcp-servers/rulesets/<id> -f enforcement=disabled
gh api -X PUT repos/mindstone/mcp-servers/rulesets/<id> -f enforcement=active
```

Say so where the team will see it: while it is off, nothing on this page holds, for anyone.

**The export's deploy key** pushes to `main` directly once the folder export from Rebel is armed, and its rollback moves `main` back with a force push. Add it when the key exists, not before, by adding this entry to the ruleset's bypass list (Settings → Rules → Rulesets, or `gh api -X PUT` with the full list):

```json
{ "actor_type": "DeployKey", "bypass_mode": "always" }
```

That entry covers every deploy key on this repository, so the export's must be the only one with write access. The ruleset targets `main` only, so `main-lkg` stays updatable. See `docs/project/OSS_FOLDER_EXPORT.md` in the Rebel repository.
