# FOX-3319 — Supply-Chain Audit: TanStack-Class Risk on `mcp-servers`

**Date:** 2026-05-13
**Scope:** `github.com/mindstone/mcp-servers` (OSS connectors monorepo)
**Branch audited:** `feature/hubspot-oss-v0.1.0` @ `6d3d36a`
**Audit type:** Repo-specific supply-chain threat model after the TanStack compromise pattern (untrusted PR / cache / artefact code influencing trusted publication).

> **Post-pivot status (2026-05-17):** This audit's threat model remains valid. Its recommendation table (sections § 4 R1–R15 and the F-series findings F1–F14) was written against a planned CI-based OIDC publishing model. That model was retired during FOX-3319 itself; publishes now happen manually from the wave-lead's dev machine (see [docs/PUBLISH_APPROVAL_PROCESS.md](../PUBLISH_APPROVAL_PROCESS.md) and [docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md](../plans/260517_PHASE_2_BOOTSTRAP_PLAN.md)). The following recommendations are **superseded** by the manual-publish architecture and should be read as historical context only:
>
> - **R1 (adopt npm OIDC trusted publishing):** no longer applicable — no CI publish path exists. The credential-exfiltration risk that motivated R1 is mitigated by the absence of any long-lived `NPM_TOKEN` in repo secrets.
> - **R2 (quarantine lifecycle scripts in publish job):** no longer applicable — no publish job exists.
> - **R6 (publish environment gate with required reviewer):** replaced by the per-release human gate in `docs/PUBLISH_APPROVAL_PROCESS.md`. The gate is now the wave-lead reading the checklist + WebAuthn 2FA + a second human's `LGTM` comment on the tracking issue.
> - **R12 (build → publish artefact handoff):** no longer applicable.
> - **R13 (force provenance at workflow env level):** no longer applicable — provenance attestations are not produced for manual publishes. Recorded as a known regression vs the planned model.
> - **R14 (release-age cool-down):** still applicable on the consumer side (`min-release-age=7` in `.npmrc`). The publish-time enforcement is moot since there is no CI publish.
> - **R15 (per-publish package-name assertion):** still applicable, now executed by the wave-lead during the G6 pre-flight (see `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`).
>
> All other recommendations (R3–R5, R7–R11, branch-protection-related items) remain in force. The threat-model sections (§ 1, § 2, § 3) are unchanged.

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

> A malicious dependency landed via reviewed PR → `npm ci` in the tag-triggered publish job runs lifecycle hooks → `NPM_TOKEN` / `CATALOG_SYNC_TOKEN` exfiltrated → arbitrary packages published under `@mindstone/`.

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
7. **Token exfil & follow-on publish.** Attacker now holds an automation token with publish rights on the `@mindstone` scope. They can publish replacement versions of any connector under that scope from anywhere.
8. **Downstream blast radius.** Hosts (Claude Desktop, Cursor, Rebel) running `npx -y @mindstone/mcp-server-*` pull the malicious replacement on next invocation. No provenance attestation means consumers cannot detect the swap. The `dispatch-catalog-sync` mechanism in our pipeline also auto-notifies the private `MindstoneRebel` repo, potentially shortening time-to-trust on the bad version inside Rebel's catalog.

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
3. `npm view @mindstone/mcp-server-<x> --json` shows `dist.attestations` populated on the next release.
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

---

## 8. Sixtuple-review addendum (post HN-thread + adversarial cross-validation)

This section consolidates findings raised during the post-remediation review pass — an adversarial cross-validator pass against the TanStack postmortem and the HN discussion at `news.ycombinator.com/item?id=48100706` (key takeaways from comments by Tanner Linsley, jonchurch_, ricardobeat, ZeWaka, fny, woodruffw and others). The initial audit's threat model held up structurally, but six concrete gaps emerged. They have been split into findings (F14–F19) and remediations (R12–R16). Items that are now FIXED in the current commit are marked **[FIXED]**; items that require further work or external configuration are marked **[OPEN]** with a pointer.

### 8.1 What the HN thread changed about the threat model

1. **The TanStack chain was not pull_request_target + lifecycle scripts; it was pull_request_target + actions/cache poisoning of a pnpm store.** The malicious cache entry was scoped to `refs/heads/main` and was restored by the `release.yml` workflow on the next main-push. Crucially: TanStack already used pnpm, which by default does not run lifecycle scripts. **pnpm did not save them.** The exploit was a GHA platform-level cache-isolation gap, not a package-manager-level lifecycle-script gap.

2. **`pull_request_target` permissions are not the same as `GITHUB_TOKEN` permissions.** TanStack's workflow had `permissions: contents: read` which the maintainers reasonably read as "this job is read-only". But the cache token used by `actions/cache` is **separate** from `GITHUB_TOKEN` and is granted **read+write to the repo's cache** regardless of the `permissions:` block. This is the documentation/UX defect at the heart of the incident.

3. **Provenance is "origin, not intent."** A direct quote from the HN thread that we now treat as load-bearing: *"SLSA provenance confirms which pipeline produced the artifact, not whether the pipeline was behaving as intended. A compromised build step can produce a validly-attested but malicious package."* OIDC trusted publishing does NOT solve compile-time / build-tool compromise; it only solves token theft.

4. **pnpm helps in two specific places, neither of which is the publish job itself.**
   - **Consumer side:** pnpm does not run lifecycle scripts by default (`onlyBuiltDependencies` allowlist). A consumer running `pnpm install @mindstone/mcp-server-x` is protected from a malicious `postinstall` we might inadvertently publish.
   - **CI cache-cooldown:** pnpm v11 ships with `minimumReleaseAge: 1440` (24h) by default. New malicious republishes have to survive 24h+ before a CI run can install them. npm v11.10+ has the equivalent setting as `min-release-age` (in days).
   None of this addresses GitHub Actions cache poisoning. That risk is structurally absent in this repo (we never use `actions/cache`), but the lesson is that switching package managers is **not** a remedy on its own.

### 8.2 New findings (F14–F19)

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| F14 | **HIGH** | Build → publish handoff | The original (pre-sixtuple-review) `publish.yml` re-ran `npx tsc` inside the publish job, which holds `id-token: write`. A compromised TypeScript transformer, vitest plugin, or any other dev-dep loaded by the build chain could mint the OIDC token and publish out-of-band. `--ignore-scripts` does NOT block this — it only blocks npm lifecycle hooks, not code reachable via `require()`/`import` once npm ci has installed dev deps. | **[FIXED]** publish.yml refactored: build job packs the tarball, uploads via `actions/upload-artifact@v4`, publish job runs ONLY `npm publish <tarball>` — no `tsc`/`shx`/`vitest`/`require()` of any third-party code in the OIDC-bearing job. |
| F15 | **HIGH** | Provenance opt-out | `--provenance` is automatic with trusted publishing but can be disabled via `NPM_CONFIG_PROVENANCE=false` (env, .npmrc, or `publishConfig` in package.json). A malicious PR could disable provenance while keeping the trusted-publisher binding, shipping authenticated-but-unattested packages. | **[FIXED]** Publish step now sets `NPM_CONFIG_PROVENANCE=true` at the **workflow env block**, which env-precedence overrides any per-package opt-out. `--provenance` is also passed explicitly on the command line for defence-in-depth. |
| F16 | **HIGH** | Release-age cool-down | Neither the audit's original remediation nor `npm audit` catches a brand-new malicious republish of a previously-clean dep (the "Shai-Hulud-style" replication path in the TanStack chain). A maintainer-approved Renovate/Dependabot bump can land the malicious version into `package-lock.json` within minutes of upstream publish. | **[FIXED, RELEASE-TIME ONLY]** Publish workflow's build step sets `NPM_CONFIG_MIN_RELEASE_AGE=7` (days) in its env block, so any release tag must clear a 7-day cool-down on every locked dep. Publish workflow installs `npm@^11.10.0` first so the setting is honoured. **Scoped to release time, not PR CI**: applying repo-wide via `.npmrc` would break PR CI every time a connector's lockfile contained a freshly-merged dep bump. Maintainer override is to comment out the env line per-tag — loud in the workflow log. |
| F17 | **MEDIUM** | Caret ranges | `^x.y.z` ranges in `connectors/*/package.json` mean a contributor running `npm install <dep>` locally (then committing the updated lockfile) re-resolves the range and can pull a newer-than-intended version. `npm ci` in our publish path is bounded by lockfile, but the **entry path** for lockfile changes (local-dev `npm install`) is unbounded. | **[PARTIAL]** `.npmrc` now sets `save-exact=true` and `save-prefix=""` so future `npm install` invocations write exact versions. Existing `^` ranges in 24 connector manifests are left in place to avoid a churn-blast in this commit; tracked as R14. |
| F18 | **MEDIUM** | Trusted-publisher workflow binding scope | npm trusted publisher bindings are scoped to a repo + workflow-file path + environment. If multiple `@mindstone/mcp-server-*` packages are all bound to the same workflow, a malicious PR that changes `package.json.name` of connector A to point at package B can publish to B's name from a tag intended for A. There is no per-package-name check in the workflow today. | **[OPEN]** R15: Add an explicit assertion in the publish step that `package.json.name` matches `@mindstone/mcp-server-${CONNECTOR}` before `npm publish`. Also add CODEOWNERS-gated approval for any `package.json.name` change. |
| F19 | **MEDIUM** | NPM_TOKEN fallback governance | If the npm-side trusted publisher binding is mis-configured at first publish attempt, the workflow will fail. Operational pressure is to "fix" it by re-adding `NPM_TOKEN`. There is no structural prevention against the secret being re-added to the `npm-publish` environment later. | **[OPEN]** R16: BRANCH_PROTECTION.md already documents "Environment secrets: none". Track via a periodic cron-job audit (out of scope of this commit) that asserts `npm-publish` has no secrets. |

### 8.3 New / revised remediations (R12–R16)

| Action | Where | Effort | Notes |
|---|---|---|---|
| **R12. Artifact-handoff between build and publish** | `publish.yml` | M | Build job packs tarball with `--ignore-scripts`, uploads via `actions/upload-artifact@v4` (run-scoped, not the cache). Publish job downloads + `npm publish <tarball>`. No JS executes in the OIDC-bearing job. **[FIXED]** |
| **R13. Force provenance at workflow env level** | `publish.yml` | XS | `NPM_CONFIG_PROVENANCE=true` in env block of publish step; can't be opted out by repo config. **[FIXED]** |
| **R14. Release-age cool-down via repo `.npmrc`** | `.npmrc`, `.gitignore`, `publish.yml`, `_template/package.json` | S | `min-release-age=7`, `save-exact=true`, `save-prefix=""`, `audit-level=high`, `provenance=true`. Publish workflow upgrades npm to 11.10+ to honour `min-release-age`. `packageManager: "npm@11.10.0"` pinned in the connector template. **[FIXED]** |
| **R15. Per-publish package-name assertion** | `publish.yml` (build job) | XS | Before packing, assert `package.json.name == "@mindstone/mcp-server-${CONNECTOR}"`. Prevents trusted-publisher binding confusion where a PR-renamed manifest publishes to a sibling package. **[OPEN]** |
| **R16. Periodic environment-secrets audit** | new `.github/workflows/audit-environment-secrets.yml` (weekly cron) | S | Use `gh api repos/.../environments/npm-publish/secrets` and fail-loud if the list is non-empty. **[OPEN]** |

### 8.4 What pnpm would and would not buy us

| Question | Answer |
|---|---|
| Does pnpm prevent the TanStack-style GHA cache poisoning? | **No.** TanStack used pnpm. The exploit was at the GHA layer, not the package manager. |
| Does pnpm prevent malicious `postinstall` running on consumer machines? | **Yes** — pnpm and bun don't run lifecycle scripts unless explicitly allowlisted (`onlyBuiltDependencies`). npm does. |
| Does pnpm enforce release-age cool-down out of the box? | **Yes** — pnpm v11 defaults `minimumReleaseAge: 1440` (24h). npm requires explicit config (`min-release-age=7`), which we now ship in `.npmrc`. |
| Would migrating to pnpm change our published packages? | **No.** The npm registry tarball is identical regardless of which tool packed it. Our consumers' choice of installer is what matters for `postinstall` protection. |
| Net recommendation | **Do not migrate to pnpm right now.** We get most of the benefit by (a) pinning `min-release-age=7` in `.npmrc`, (b) `save-exact=true`, (c) `--ignore-scripts` in the publish flow, (d) recommending pnpm/bun to consumers in the README. Cost of a 24-connector lockfile migration outweighs the marginal residual risk. Revisit if/when `min-release-age` proves insufficient in production. |

### 8.5 Residual risk after R12–R14 (FIXED items)

The shortest viable adversary path now is:
1. Land a malicious dev-dep via reviewed PR (CODEOWNERS gate applies).
2. Wait 7+ days for `min-release-age` to clear.
3. A maintainer cuts a release tag. Build job runs `npm ci`, then `npm run build` (the malicious dep executes here), poisoning `dist/`. Tests pass (or don't, depending on attacker subtlety).
4. Build job packs the poisoned `dist/` into a tarball and uploads it as an artifact.
5. Publish job downloads the tarball and runs `npm publish <tarball>`. Provenance attestation is generated — but it attests *origin*, not *intent*. The attested tarball contains poisoned compiled code.
6. Consumers `npx -y @mindstone/mcp-server-x` and execute the poisoned code on their machines.

What was eliminated vs the original chain:
- ✅ OIDC token exfil from publish job: gone. Publish job has no JS hook to hijack.
- ✅ Same-day malicious republish: gone. 7-day cool-down.
- ✅ Lifecycle-script RCE at install time: gone. `--ignore-scripts` in publish.
- ✅ Cache poisoning (TanStack chain): structurally absent. We don't use `actions/cache`.
- ❌ Compile-time poisoning of `dist/`: **still possible**, gated only by CODEOWNERS approval on dep changes + min-release-age.

What still needs work to break the residual path:
- **R17 (OPEN, P3):** Reproducible builds with multi-party signed attestation (`Bitcoin-core-style`). Out of scope for now; tracked as a research item.
- **R18 (OPEN, P3):** Sandboxed build job via `step-security/harden-runner` egress allowlist — restrict network access during `npm run build` so a compromised build tool cannot exfiltrate to attacker.com even if it executes. Pinned commit SHA: `cb605e52c26070c328afc4562f0b4ada7618a84e` (v2.10.4).
- **R19 (OPEN, P3):** Run the build job inside an OS-level sandbox (e.g. `bubblewrap`, `firejail`, or a non-internet-routable container) for connectors that don't legitimately need network during build.

### 8.6 Updated validation checklist

Add to §6:

9. `min-release-age=7` is present in repo-level `.npmrc` and `/.npmrc` is tracked by git.
10. `.gitignore` allows `/.npmrc` while still ignoring nested `.npmrc` files.
11. `publish.yml` build job uses `actions/upload-artifact@b4b15b8c…` (v4.4.3) pinned; publish job uses `actions/download-artifact@fa0a91b8…` (v4.1.8) pinned.
12. Publish job does NOT contain any step that invokes `tsc`, `shx`, `vitest`, `node ./scripts/`, or `npm run *`.
13. Publish job's env block contains `NPM_CONFIG_PROVENANCE: 'true'`.
14. `package.json.name == "@mindstone/mcp-server-<connector>"` assertion present in publish.yml (R15) — **NOT YET DONE**.
15. Periodic environment-secrets audit workflow exists (R16) — **NOT YET DONE**.

