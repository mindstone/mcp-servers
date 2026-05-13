# Branch & Tag Protection Requirements

**Status:** Required for OSS launch. Tracked under FOX-3319 (P1 R8).
**Audience:** Repo administrators on `mindstone-engineering/mcp-servers`.

These settings live in GitHub UI / API, not in repo files, so they are
documented here to keep settings drift visible and reviewable.

## 1. Branch protection — `main`

Configure under `Settings → Branches → Add rule` (or via the Branch
Protection API).

| Setting | Required value | Rationale |
|---|---|---|
| Require a pull request before merging | **On** | No direct pushes to `main`. |
| Required approving reviews | **>= 1** (>= 2 once team size allows) | Pair with CODEOWNERS. |
| Dismiss stale approvals on new commits | **On** | Prevents review-then-poison race. |
| Require review from Code Owners | **On** | Enforces `.github/CODEOWNERS`. |
| Require status checks to pass | **On**, must include: `build-and-test`, `validate` (server.json check) | Blocks merge on CI fail. |
| Require branches to be up to date before merging | **On** | Closes the merge-train substitution gap. |
| Require conversation resolution before merging | **On** | Forces explicit review acknowledgement. |
| Require signed commits | **On** | Closes commit-spoofing on `main`. |
| Require linear history | **On** | Predictable ancestry for `verify tag is on main` in `publish.yml`. |
| Include administrators | **On** | No bypass for admins. |
| Restrict who can push | **maintainers team only** | `publish.yml`'s ancestor check assumes `main` cannot be force-rewritten. |
| Allow force pushes | **Off** | Mandatory. |
| Allow deletions | **Off** | Mandatory. |

## 2. Tag protection — `*-v*`

Configure under `Settings → Tags → Add rule`. The publish workflow triggers
exclusively on this tag pattern (`*-v*`), so tag-push permission is
equivalent to publish permission.

| Setting | Required value |
|---|---|
| Pattern | `*-v*` |
| Restrict who can push tags | **maintainers team only** |
| Require signed tags | **On** (once tooling supports it) |

## 3. Environment — `npm-publish`

Configure under `Settings → Environments → npm-publish`. The publish job in
`.github/workflows/publish.yml` declares `environment: npm-publish`, so
these settings gate every npm publish.

| Setting | Required value |
|---|---|
| Required reviewers | **>= 1 maintainer** (distinct from PR approver where possible) |
| Wait timer | 0 (rely on reviewer approval) |
| Deployment branches and tags | Selected: tags matching `*-v*` only |
| Environment secrets | **none** (publish uses OIDC; legacy `NPM_TOKEN` MUST be removed once trusted publishing is configured) |

## 4. npm-side configuration (out of repo, but required)

For OIDC trusted publishing to function, configure on the npm org side:

- Each `@mindstone-engineering/mcp-server-*` package: enable `Trusted Publisher`
  bound to GitHub repository `mindstone-engineering/mcp-servers`, workflow
  `.github/workflows/publish.yml`, environment `npm-publish`.
- Org-wide: enforce 2FA for all members.
- Org-wide: enforce `2FA required for publishing` per package.
- Rotate and **revoke** the legacy `NPM_TOKEN` secret once trusted
  publishing is confirmed working on a test connector.

## 5. Verification (post-config)

After applying, the following commands should succeed/return as noted:

```bash
# Branch protection in place
gh api repos/mindstone-engineering/mcp-servers/branches/main/protection \
  --jq '.required_pull_request_reviews.require_code_owner_reviews'
# expect: true

# Tag protection in place
gh api repos/mindstone-engineering/mcp-servers/tags/protection \
  --jq '.[].pattern'
# expect: "*-v*"

# OIDC + provenance on next publish
npm view @mindstone-engineering/mcp-server-<x>@<version> --json \
  | jq '.dist.attestations'
# expect: non-null with bundleUrl
```
