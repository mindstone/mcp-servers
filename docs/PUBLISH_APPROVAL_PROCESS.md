# Publish Approval Process

Every connector publish to npm under `@mindstone/mcp-server-*` is gated on an explicit human approval. This document defines the gate.

> **Architecture mode (since FOX-3319 pivot, 2026-05-17):** Publishes happen manually from the wave-lead's dev machine using `npm publish`. There is **no CI publish workflow** — the previous `.github/workflows/publish.yml` was deleted. The OIDC / Trusted-Publisher / `npm-publish` GitHub environment model described in earlier revisions of this document is **superseded**; commit history preserves it for reference.

## Why a human gate?

The publish credential is the npm session of the `mindstone-engineering` account on the wave-lead's local machine. That session is protected by:

1. **WebAuthn (security-key) 2FA** on the npm account. Every `npm publish` invocation triggers a system-browser challenge that requires physical presence with the registered hardware key. No automation token sits on disk; no long-lived `NPM_TOKEN` lives in a CI secret.
2. **PR review on the version-bump commit.** The package.json/server.json/lockfile bump that defines what gets published lives in a PR on `main`, gated by branch protection + CODEOWNERS (`@mindstone/oss-maintainers`). A separate human reviewer must approve that PR before the wave-lead can `git pull` it locally and publish.
3. **The wave-lead reading this checklist** before each `npm publish`. The checklist below is the equivalent of the old "Approve and deploy" environment-reviewer step — except it runs in the publisher's head, recorded in the tracking issue, instead of in GitHub's audit log.

This document is the policy layer on top of those structural mitigations: even if every PR check passes, the wave-lead must still confirm the release is intentional before invoking `npm publish`.

## Pre-publish checklist (per connector, per version)

Before running `npm publish` for `<connector>@<X.Y.Z>`, the wave-lead opens (or comments on) a tracking issue titled `Publish approval: <connector> v<X.Y.Z>` and confirms:

- [ ] **Source-level security review:** at least two independent reviewers have signed off on the version-bump PR on `main`. All CRITICAL and HIGH findings either resolved or explicitly accepted with a named risk owner. (Branch protection enforces `>=2` approvals once team size allows; until then, an out-of-band review acknowledgement counts.)
- [ ] **Live runtime probe (where defined):** `npm run probe:live:gate` PUBLISH-GATE OK against a real workspace, on the packed binary not just unit tests. Required for connectors that ship a live-probe script (currently: `slack`); for connectors without one, a smoke run of `npm pack --ignore-scripts` followed by `npx ./<connector>-<version>.tgz` against the documented `command` line in the connector README serves as the equivalent.
- [ ] **Tarball clean:** `npm pack --dry-run --ignore-scripts` shows no `.map`, no `.test.` / `__tests__/`, no nested `.tgz`, no `.env*`, no `.npmrc`, and no raw `.ts` source files. The G6 procedure in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` includes a shell-based forbidden-file scan; copy it into your terminal session for each publish.
- [ ] **`npm audit`:** 0 critical / 0 high / 0 moderate on `--omit=dev` (production closure). Remaining moderate findings must each have a named risk owner.
- [ ] **CHANGELOG.md:** `[<X.Y.Z>] - <date>` section present (hyphen or em-dash both accepted) and describes user-facing changes + security-relevant changes. The PR check `.github/workflows/changelog-check.yml` already enforces the header on every version-bump PR; the manual step is reviewing that the content is honest.
- [ ] **Version sync — five places:** `package.json#version`, `package-lock.json#version` (top-level + `packages[""].version`), `server.json#version` (top-level + `packages[0].version`) all match the version you are about to type into the `npm publish` invocation. (The `server-json-check.yml` workflow catches `package.json` vs `server.json` drift on every PR; the lockfile cross-check is the human's job.)
- [ ] **Package-name binding intact:** `package.json.name` is exactly `@mindstone/mcp-server-${CONNECTOR}` where `${CONNECTOR}` is the directory slug. No PR has tried to rename the package since the last publish.
- [ ] **Named maintainer on call:** A human takes ownership of the version for the next 7 days for security response. This human's name + GitHub handle are recorded in the issue. The 7-day window is calibrated to the `min-release-age=7` cool-down enforced at publish time — consumers with that setting will not install this version unattended until day 7, so the on-call window covers the period during which a recall would matter.
- [ ] **Publisher set documented:** The npm package's `maintainers` list on npm matches the named maintainer + at least one backup. Verify with `npm view @mindstone/mcp-server-<connector> maintainers`. For bootstrap publishes (any connector not already on `@mindstone/`), this list will be empty until step 4 of the runbook below lands.
- [ ] **Approval recorded:** A separate human (not the author of the release commit) leaves a `LGTM — approve publish` comment on the tracking issue. That comment is the policy artefact replacing the old `npm-publish` environment approval.

## Per-publish runbook

The canonical procedure is in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` § "Per-publish runbook". Summary (rounded to wall-time per package):

1. Refresh `main`, confirm clean tree — 30 s
2. Sanity-check the connector slice (name + version) — 10 s
3. Build + test + audit + pack-scan locally — ~1-2 min depending on connector
4. `npm publish --access=public` — interactive WebAuthn prompt
5. Confirm publish landed (`npm view ... version`) — 5 s
6. Fire catalog-sync dispatch to Rebel via `gh api` — 5 s
7. Watch for Rebel workflow + catalog-sync PR — ~3 min
8. Update the publish tracker

## What we get (and don't get) without OIDC provenance

- **Don't get:** Sigstore-signed provenance attestations linking the tarball to a specific GitHub Actions run. `npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json | jq .dist.attestations` returns null. `npm audit signatures` reports `Verified registry signatures` for npm's own signing but `bundleUrl` is absent. Consumers who consult provenance to validate releases get a weaker guarantee than they did with the (planned-but-never-shipped) OIDC model.
- **Do get:** A human chain of custody — the wave-lead's WebAuthn 2FA + their identity in the tracking issue. The wave-lead's `npm whoami` matches the npm publisher account on the released version (verifiable via `npm view ... maintainers`). The release commit on `mindstone/mcp-servers` matches the tarball contents (verifiable by re-running `npm pack` at the publish commit and comparing the shasum from the `npm publish` output).

A future iteration can reintroduce OIDC publishing if the team decides the provenance attestations are worth the bootstrap cost (per-package Trusted Publisher setup + GitHub environment reviewer rule). That decision is deferred to the post-Phase-3 retrospective.

## Hygiene (quarterly review)

Owner: the wave-lead, with the second `@mindstone/oss-maintainers` member doing the cross-check.

- Confirm `npm whoami` on the wave-lead's machine returns the expected publisher account.
- Confirm `npm access list packages @mindstone` lists every connector that has been published so far. A missing entry indicates either a failed publish or an unintended unpublish.
- Confirm npm org-level 2FA is still enforced (`npm org ls mindstone` — every member shows their authentication mode in the npm UI). At time of writing the publisher account is WebAuthn-only.
- Confirm no orphan `NPM_TOKEN` lives in `Settings → Secrets and variables → Actions` on `mindstone/mcp-servers`. With manual-publish mode, there is no legitimate use for that secret in the repo. If a token shows up, revoke it and rotate the publisher account's password.
- Confirm `.github/workflows/` contains no resurrected publish workflow. If one appears, get explicit sign-off from the wave-lead before merging.
- Add a second `@mindstone/` npm member before any future single-publisher emergency. Tracked in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` open questions.

## Cross-references

- [Phase 2 bootstrap plan + publish tracker](plans/260517_PHASE_2_BOOTSTRAP_PLAN.md) — single source of truth for the active wave
- [Threat model + audit findings (historical)](security/AUDIT_FOX-3319_tanstack_supply_chain.md) — recommendation table is partially superseded by the manual-publish pivot; the threat model itself remains valid
- [Branch + tag protection settings](security/BRANCH_PROTECTION.md) — the repo-side preconditions that gate the version-bump PR
- [Emergency revoke runbook](EMERGENCY_REVOKE.md) — what to do when a published version turns out to be compromised
- [Migration runbook (legacy scope cutover)](../MIGRATION.md) — the post-wave deprecation procedure for `@mindstone-engineering/*`
- [Repository security policy](../SECURITY.md)
- [Release process for contributors](../CONTRIBUTING.md#release-process) — the bump-and-CHANGELOG workflow the PR check enforces
