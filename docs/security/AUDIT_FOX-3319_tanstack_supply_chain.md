# FOX-3319 — Supply-Chain Audit: TanStack-Class Risk on `mcp-servers`

**Date:** 2026-05-13
**Scope:** `github.com/mindstone-engineering/mcp-servers` (OSS connectors monorepo)
**Branch audited:** `feature/hubspot-oss-v0.1.0` @ `6d3d36a`
**Audit type:** Repo-specific supply-chain threat model after the TanStack compromise pattern (untrusted PR / cache / artefact code influencing trusted publication).

---

## 1. Threat Model Summary

### 1.1 TanStack attack class — the pattern we're testing for

A canonical "TanStack-style" compromise chains four ingredients:

1. **Trust-boundary leak in CI** — workflows triggered by a fork PR run with elevated context (e.g. `pull_request_target`, base-repo `GITHUB_TOKEN`, secrets) or write to state that a privileged job later restores.
2. **Cross-context state** — caches (`actions/cache`), uploaded artefacts, Docker layers, or workspace files persist attacker code across job boundaries.
3. **Trusted publisher** — a release job consumes that poisoned state and publishes signed-by-org packages (npm, registry, attestations) using long-lived credentials or OIDC tokens.
4. **No CODEOWNERS / no environment gate** — a single reviewer can land a dependency or workflow change that the next tag release will execute.

### 1.2 How the chain maps onto `mcp-servers` today

| Ingredient | Present? | Notes |
|---|---|---|
| `pull_request_target` / fork-with-secrets | **No** | All workflows use `pull_request` (no token elevation on forks). |
| Reusable workflows / `workflow_call` / `workflow_run` | **No** | `grep` finds zero references. |
| `actions/cache`, `upload-artifact`, `download-artifact` | **No** | Zero usages. Cache-poisoning vector is structurally absent. |
| Docker layer cache shared with publish | **No** | No Docker in CI/release. |
| Publish triggered by PR merge | **No** | Publish is gated on tag push `*-v*`. |
| Long-lived publish credential | **YES** | `secrets.NPM_TOKEN` (classic automation token). No OIDC, no `npm publish --provenance`. |
| Cross-repo PAT in same workflow | **YES (isolated)** | `secrets.CATALOG_SYNC_TOKEN` is used in a *separate job* (`dispatch-catalog-sync`) without `setup-node`/`NPM_TOKEN`. |
| Lifecycle scripts run with secrets in scope | **YES** | `npm ci` (and the `prepare` script on every connector) runs *before* `npm publish` inside the publish job — same env as `NPM_TOKEN`. |
| Third-party action pinning | **Partial** | `peter-evans/repository-dispatch` pinned to SHA. `actions/checkout@v4` and `actions/setup-node@v4` use mutable tag refs. README claims "pinned to commit SHAs for third-party actions" — that claim is currently inaccurate. |
| CODEOWNERS for sensitive paths | **No** | No `CODEOWNERS` file. `.github/workflows/`, `package.json`, `package-lock.json` have no path-specific reviewer gate. |
| Environment-approval gate on publish | **No** | No `environment:` block; any maintainer with tag-push permission triggers publish. |

### 1.3 Net residual exposure

The two cache/artefact pillars of the TanStack chain (#1 trust-leak, #2 cross-context state) are not exploitable today — the repo simply doesn't have those mechanisms. The remaining exposure is the **classic dependency-substitution / build-time-RCE → token exfiltration** chain that converges on the publish job:

> A malicious dependency landed via reviewed PR → `npm ci` in the tag-triggered publish job runs lifecycle hooks → `NPM_TOKEN` / `CATALOG_SYNC_TOKEN` exfiltrated → arbitrary packages published under `@mindstone-engineering/`.

This is the same outcome class as TanStack, reached by a different (and shorter) path.

---

## 2. Findings

| # | Severity | Area | Finding |
|---|---|---|---|
| F1 | **HIGH** | Publish credentials | Long-lived `NPM_TOKEN` in publish job; no OIDC trusted publishing; no `--provenance` attestation. |
| F2 | **HIGH** | Build/publish isolation | `npm ci` + `prepare` lifecycle hooks run in the **same job and shell** as `npm publish`, with `NPM_TOKEN` and `CATALOG_SYNC_TOKEN` reachable. |
| F3 | **HIGH** | Action pinning | `actions/checkout@v4` and `actions/setup-node@v4` use mutable tag refs across every workflow (CI, publish, server-json-check, commit-notify). README implies SHA pinning is in force; it is not. |
| F4 | **HIGH** | Binary supply chain | `server-json-check.yml` downloads `mcp-publisher_linux_amd64.tar.gz` over HTTPS with **no SHA-256 / signature / attestation check**. Pinned only to version string `v1.7.7`. |
| F5 | **MEDIUM** | Review boundary | No `CODEOWNERS`. Workflow files, every `package.json`, every `package-lock.json`, and `LICENSE` can be modified with one approval from any maintainer. |
| F6 | **MEDIUM** | Release gate | Publish workflow has no `environment: production` (or equivalent) with required reviewer. Tag push = immediate publish. No second-pair-of-eyes step. |
| F7 | **MEDIUM** | Audit gap at publish time | `npm audit --audit-level=high --omit=dev` runs in **CI matrix** but **not** in `publish.yml`. Only the `hubspot` connector enforces audit via `prepublishOnly`; the other 23 do not. A newly disclosed CVE between PR-merge and tag-cut would ship without warning. |
| F8 | **MEDIUM** | Lockfile drift | `npm ci` is correct, but there is no Renovate/Dependabot policy that requires CODEOWNERS approval for `package-lock.json` changes. Lockfile is the single point of definition for what runs at publish. |
| F9 | **MEDIUM** | Tag protection | `verify tag is on main` correctly checks ancestry, but assumes main is protected. No documented branch protection / signed-tag requirement / tag-push permission scope. (Cannot be verified from repo contents alone — recommend documenting & enforcing in GitHub settings.) |
| F10 | **MEDIUM** | Catalog dispatch token scope | `CATALOG_SYNC_TOKEN` is a classic PAT with `repository_dispatch` write to `MindstoneRebel`. If a future change pulls it into the publish job (e.g. someone "consolidates" the two jobs), it gains write to a private downstream repo. The isolation comment in `publish.yml` is the only thing preventing this. |
| F11 | **LOW** | Notify-job secret reach | `notify-failure` in `ci.yml` runs `if: failure()` and consumes `SLACK_WEBHOOK_URL`. Already env-fy'd correctly (CWE-94 hardened). Risk is residual Slack-spam DoS, not credential theft. |
| F12 | **LOW** | Fork-PR secret behaviour | `pull_request` events on PRs from forks do not receive `SLACK_WEBHOOK_URL`. The current code handles this with `if [ -z "$SLACK_WEBHOOK_URL" ]; then ...; exit 0`. Confirmed safe. |
| F13 | **LOW** | Slack payload injection | All `${{ github.* }}` references in `commit-notify.yml`, `pr-notify.yml`, `ci.yml` are passed via `env:` and used in jq with `--rawfile`/`--arg`. Confirmed not vulnerable to script injection. Worth a regression test in CI lint. |

---

## 3. TanStack-Style Exploit Walkthrough (hypothetical)

Concrete kill-chain that would currently succeed against `mcp-servers` if a malicious-but-plausible PR were merged:

1. **PR step.** Attacker opens an innocuous PR against `connectors/<x>/` that adds `"some-helper": "^1.2.0"` to `dependencies`. `some-helper@1.2.0` on the npm registry is currently benign; tests pass; `npm audit --audit-level=high` is clean. PR is merged by any maintainer.
2. **Lockfile.** `package-lock.json` now pins `some-helper@1.2.0` with the current sha512 integrity. CI keeps passing.
3. **npm-side substitution.** Attacker (also the owner of `some-helper`) publishes `1.2.1` whose `package.json` has `"postinstall": "node ./bootstrap.js"`, where `bootstrap.js` reads `process.env.NPM_TOKEN`, base64-encodes it, and POSTs it to `https://example.com/x`.
   - *Note:* `npm ci` honours `package-lock.json` so a fresh attacker version doesn't get pulled directly. The chain therefore continues at (4) — the lockfile-controlled version is the one that ships.
4. **Lockfile bump.** Either:
   - Renovate/Dependabot opens a routine bump PR that updates `some-helper` to `1.2.1`. Reviewer sees a minor bump from a previously-clean dep and approves. (No CODEOWNERS on `package-lock.json`, so any reviewer suffices.)
   - Or attacker themselves opens a "fix audit warning / minor bump" PR.
5. **Tag push.** Routine release: a maintainer pushes tag `<x>-v1.3.0`. `publish.yml` triggers.
6. **RCE in publish job.** First step in publish job is `npm ci`. `some-helper@1.2.1`'s `postinstall` script runs. Same shell, same env block, has `NODE_AUTH_TOKEN=$NPM_TOKEN` (set in the publish step), `GITHUB_TOKEN` (default), and after step boundaries, runner state has `secrets.NPM_TOKEN` reachable via filesystem (`~/.npmrc` is written by `setup-node` in this job).
7. **Token exfil & follow-on publish.** Attacker now holds an automation token with publish rights on the `@mindstone-engineering` scope. They can publish replacement versions of any connector under that scope from anywhere.
8. **Downstream blast radius.** Hosts (Claude Desktop, Cursor, Rebel) running `npx -y @mindstone-engineering/mcp-server-*` pull the malicious replacement on next invocation. No provenance attestation means consumers cannot detect the swap. The `dispatch-catalog-sync` mechanism in our pipeline also auto-notifies the private `MindstoneRebel` repo, potentially shortening time-to-trust on the bad version inside Rebel's catalog.

The chain assumes only **one** social-engineering step (a single approving review) and **one** prior unrelated PR (the initial benign dep addition). No fork PR, no cache poisoning, no `pull_request_target` abuse is required.

---

## 4. Prioritised Remediation Plan

### P0 — Block the RCE-→-token path (must-fix before broader OSS launch)

| Action | Where | Effort | Notes |
|---|---|---|---|
| **R1. Adopt npm trusted publishing (OIDC)** | `publish.yml` | M | Add `permissions: id-token: write` to publish step *only*; remove `NPM_TOKEN`; bind via `npm publish --provenance`. Requires npm org config (one-time). Closes F1. |
| **R2. Quarantine lifecycle scripts in publish job** | `publish.yml` | S | Split into two steps: (a) `npm ci --ignore-scripts && npm run build` in a step where the publish secret is *not* in the env; (b) `npm publish --ignore-scripts --provenance` with the secret. Or run install in a prior job and pass `dist/` over OIDC-attested artefact. Closes F2. |
| **R3. Pin every action to a commit SHA** | All 5 workflows | S | Replace `actions/checkout@v4` with `actions/checkout@<sha>  # v4.x.y`. Add Dependabot config (`.github/dependabot.yml`) for `package-ecosystem: github-actions` with a CODEOWNERS-gated update path. Update README accordingly (claim currently overstates). Closes F3. |
| **R4. Verify `mcp-publisher` binary** | `server-json-check.yml` | S | Add `sha256sum -c` against a checked-in expected hash, or `gh attestation verify`. Closes F4. |

### P1 — Reduce single-reviewer blast radius

| Action | Where | Effort | Notes |
|---|---|---|---|
| **R5. Add CODEOWNERS** | `.github/CODEOWNERS` | S | Require maintainer team for `.github/`, `connectors/*/package.json`, `connectors/*/package-lock.json`, `LICENSE`, `SECURITY.md`. Closes F5. |
| **R6. Publish environment gate** | `publish.yml` + GitHub UI | S | Add `environment: npm-publish` to publish job; configure required reviewers in GitHub UI. Closes F6. |
| **R7. Make `npm audit` a publish-time gate for all connectors** | `_template/` + each connector | S | Promote hubspot's `prepublishOnly` audit to the template; add an audit step in `publish.yml` itself (cheap belt-and-braces). Closes F7. |
| **R8. Document branch & tag protection** | `docs/security/BRANCH_PROTECTION.md` (new) | XS | Require signed commits on main; restrict `tags/*-v*` push to maintainers; require linear history. Document in repo so settings drift is visible. Closes F9. |

### P2 — Defence in depth

| Action | Where | Effort | Notes |
|---|---|---|---|
| **R9. Scope-narrow the catalog-sync token** | GitHub Apps | M | Replace PAT `CATALOG_SYNC_TOKEN` with a GitHub App install token scoped to `repository_dispatch` on a single repo, or a fine-grained PAT with explicit expiry. Closes F10. |
| **R10. CI lint for workflow injection** | new `.github/workflows/lint-workflows.yml` | S | Run `zizmor`, `actionlint`, and a regex check that any `${{ github.event.* }}` substitution occurs only inside an `env:` block — keeps F11/F13 from regressing. |
| **R11. Provenance verification on consumer side** | Rebel host code (out of scope of this repo but tracked) | M | Once R1 lands, hosts can verify `npm view <pkg> --json` includes `dist.attestations`; reject unverified upgrades. |

### Effort key
- XS ≈ <30 min, S ≈ <half day, M ≈ 1–2 days, L ≈ >2 days.

---

## 5. Positive findings (worth keeping)

These are doing real work and should be preserved:

- ✅ No `pull_request_target`, no `workflow_call`, no `workflow_run`.
- ✅ No `actions/cache`, no `upload-artifact`, no `download-artifact`. Entire TanStack cross-context state vector is structurally absent.
- ✅ `dispatch-catalog-sync` is correctly isolated from `NPM_TOKEN` — separate job, no `setup-node`, explicit comment.
- ✅ `verify tag is on main` (`git merge-base --is-ancestor`) prevents publishing from a detached / forked branch.
- ✅ `commit-notify.yml` injection-hardening (`env:` pass-through, `jq --rawfile`) is exemplary and documented in-file.
- ✅ Per-connector `prepublishOnly` already exists on `hubspot` and `slack` (host-string scanner + audit). Good template to generalise.
- ✅ `connectors/slack` and `connectors/hubspot` already do `npm pack --ignore-scripts` for artefact scanning — pattern to copy into publish flow.

---

## 6. Validation checklist (post-remediation)

To confirm the chain is broken after P0:

1. Confirm `permissions: id-token: write` is scoped to a single step in `publish.yml` only.
2. Confirm `NPM_TOKEN` is removed from repo secrets (or kept only as emergency manual-publish, with audit log review).
3. `npm view @mindstone-engineering/mcp-server-<x> --json` shows `dist.attestations` populated on the next release.
4. `actionlint -shellcheck=` clean across all workflows.
5. `git grep -nE '@(v[0-9]|main|master)\s*$' .github/workflows` returns zero non-SHA refs.
6. `sha256sum -c` step present in `server-json-check.yml` against a checked-in expected hash.
7. GitHub UI: `npm-publish` environment exists with at least one required reviewer.
8. `.github/CODEOWNERS` exists and `.github/workflows/` is owned by the maintainer team.

---

## 7. Out of scope (flagged for separate audits)

- Per-connector code (LLM-host vocabulary leakage, SSRF, path traversal, etc.) — already covered by recent staged reviews on `hubspot`, `google-analytics`, `outreach`, `salesforce`, etc. and tracked in commit history.
- Rebel host code that consumes these packages (provenance verification, sandboxing of `npx` exec). Tracked separately; R11 above is a forward-looking dependency.
- GitHub organisation-level controls (SSO, 2FA enforcement, npm 2FA, npm "publish requires 2FA" toggle). Recommend enforcing org-wide; outside this repo's files.
