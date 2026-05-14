# Publish Approval Process

Every connector publish to npm under `@mindstone/mcp-server-*` is gated on an explicit human approval. This document defines the gate.

## Why a human gate?

The publish workflow (`.github/workflows/publish.yml`) uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) over OIDC: the workflow mints a short-lived id-token at runtime and presents it to npm, which validates the binding (repo + workflow path + GitHub Actions environment) and lets the publish through. **No `NPM_TOKEN` is stored in the repo's secrets.** That removes the long-lived-credential exfiltration risk that motivated the FOX-3319 audit.

Two structural mitigations sit underneath the OIDC binding:

1. **The `npm-publish` GitHub Actions environment is the human gate.** The publish job declares `environment: npm-publish`. The environment is configured (in repo Settings → Environments) with at least one required reviewer who is NOT the author of the release commit. Pushing the `<connector>-v<X.Y.Z>` tag does not start the publish — it pauses on environment approval until a maintainer clicks "Approve and deploy". That approval is the equivalent of the old 2FA prompt, recorded in the GitHub audit log.
2. **The publish job runs no third-party JavaScript.** The `build` job in `publish.yml` installs, tests, audits, packs, and generates the SBOM with NO `id-token: write` permission and NO publish credentials. It hands a tarball to the `publish` job via `actions/upload-artifact` (run-scoped, not GHA cache — that distinction is load-bearing). The `publish` job has `id-token: write` but does NOT run `npm ci`, `tsc`, `vitest`, or any lifecycle script; it only invokes `npm publish <tarball> --ignore-scripts --provenance`. A TanStack-class compile-time RCE in a dependency therefore cannot reach the OIDC token mint. See `docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md` for the threat model.

This document is the policy layer on top of those structural mitigations: even if every workflow check passes, a human must still confirm the release is intentional.

## Pre-publish checklist (per connector, per version)

Before tagging `<connector>-v<X.Y.Z>`, confirm in a tracking issue titled `Publish approval: <connector> v<X.Y.Z>`:

- [ ] **Source-level security review:** § 13 review run with at least 2 independent reviewers; all CRITICAL and HIGH findings either resolved or explicitly accepted with named risk owner.
- [ ] **Live runtime probe (where defined):** `npm run probe:live:gate` PUBLISH-GATE OK against a real workspace, on the packed binary not just unit tests. Required for connectors that ship a live-probe script (currently: `slack`); for connectors without one, a smoke run of `npm pack --ignore-scripts` followed by `npx ./<connector>-<version>.tgz` against the documented `command` line in the connector README serves as the equivalent.
- [ ] **Tarball clean:** `npm pack --dry-run --ignore-scripts` shows no `.map`, no `.test.` / `__tests__/`, no nested `.tgz`, no `.env*`, no `.npmrc`, and no raw `.ts` source files. `publish.yml` already fails the build on `.map` and `.test.`; verify the remaining four classes manually until the workflow guard is widened.
- [ ] **`npm audit`:** 0 critical / 0 high / 0 moderate on `--omit=dev` (production closure). `publish.yml` already fails the build at `--audit-level=high`; the moderate-tier check is the human review on top. Remaining moderate findings must each have a named risk owner.
- [ ] **CHANGELOG.md:** `[<X.Y.Z>] - <date>` section present (hyphen or em-dash both accepted) and describes user-facing changes + security-relevant changes. The PR check `.github/workflows/changelog-check.yml` already enforces the header on every version-bump PR; the manual step is reviewing that the content is honest.
- [ ] **Version sync — four places:** `package.json#version`, `package-lock.json#version` (top-level + `packages[""].version`), `server.json#version` (top-level + `packages[0].version`), and the proposed git tag all match. `publish.yml` re-asserts package.json ↔ tag and runs a partial src/server.ts check for the (rare) connectors that hard-code a literal; the server.json + lockfile cross-check is the human's job until that lands in CI.
- [ ] **Package-name binding intact:** `package.json.name` is exactly `@mindstone/mcp-server-${CONNECTOR}` where `${CONNECTOR}` is the directory slug. `publish.yml` enforces this on every run (R15); the human-side check is making sure no PR has tried to rename the package in a way the workflow would let through (i.e. directory + slug + scope all match the trusted-publisher binding on npm).
- [ ] **Named maintainer on call:** A human takes ownership of the version for the next 7 days for security response. This human's name + GitHub handle are recorded in the issue. The 7-day window is calibrated to the `min-release-age=7` cool-down enforced at publish time — consumers with that setting will not install this version unattended until day 7, so the on-call window covers the period during which a recall would matter.
- [ ] **Publisher set documented:** The npm package's `maintainers` list on npm matches the named maintainer + at least one backup. Verify with `npm view @mindstone/mcp-server-<connector> maintainers`. For the three connectors with no `@mindstone-engineering/` predecessor on the registry (hubspot, slack, google-analytics), this list will be empty until the bootstrap publish in MIGRATION.md step 2 lands.
- [ ] **Approval recorded:** A separate human (not the author of the release commit) leaves a `LGTM — approve publish` comment on the tracking issue AND approves the `npm-publish` GHA environment on the workflow run. Both records are required: the issue comment is the policy artefact, the environment approval is the technical gate.

## What `--provenance` gives us (and doesn't)

- **Gives:** A Sigstore-signed attestation linking the published tarball to this repo, this commit, this workflow run. Anyone can verify with `npm audit signatures` or by inspecting the signature at https://search.sigstore.dev. `NPM_CONFIG_PROVENANCE=true` is forced in the publish step (env block) so neither the repo `.npmrc` nor a malicious dep introducing `provenance=false` into nested config can opt out without rewriting the workflow itself.
- **Doesn't give:** Defence against a compromise of the OIDC mint path. If an attacker can run arbitrary JavaScript inside the `publish` job they can mint a signed-but-malicious release. The build/publish job split is what makes that path structurally hard — the OIDC-bearing job has no JS runtime hook to hijack — and the `npm-publish` environment approval is the policy gate on top. A human who recognises that a release shouldn't be happening can decline the environment prompt and the OIDC token is never minted at all.

## Trusted-publisher binding hygiene

The Trusted Publisher binding on npm couples three identities together: **repo**, **workflow file path**, **GHA environment name**. If any one drifts (PR renames the workflow file, repo moves to a different org, environment is deleted) the binding fails closed — `npm publish` returns 403 and the publish does not happen.

Quarterly review (named maintainer of `_template/`, currently: TBD):

- For each `@mindstone/mcp-server-<connector>` package on npmjs.com → Access tab → Trusted Publisher, confirm: repo is `mindstone/mcp-servers`, workflow file is `publish.yml`, environment is `npm-publish`. Drift indicates either a config mistake or an attacker probing the binding.
- Confirm no orphan `NPM_TOKEN` lives in repo Settings → Secrets and variables → Actions. Trusted publishing replaces the token; if one is still present after the first OIDC publish, revoke it (per `MIGRATION.md` pre-flight checklist).
- Confirm the `npm-publish` environment still has at least one required reviewer who is NOT a current maintainer of `_template/`. The reviewer-must-not-be-author rule depends on the reviewer list being kept distinct from the proposer list; a reviewer set that collapses to one person bypasses the gate.
- Confirm org-level 2FA on npm is still enforced (`npm access list users mindstone --json | jq '. | length'` should match the in-repo maintainer roster). OIDC bypasses 2FA on the publish path but interactive `npm deprecate`, `npm token revoke`, `npm access revoke` (the MIGRATION.md step-5 commands) all still require it.

## SBOM and provenance verification

After every publish, the workflow uploads a CycloneDX 1.5 SBOM as a workflow artifact (365-day retention) and writes the provenance attestation onto the published version. To verify a published version:

```bash
# Verify Sigstore attestation
npm audit signatures @mindstone/mcp-server-<connector>@<X.Y.Z>

# Inspect provenance JSON (dist.attestations is non-empty for OIDC-published versions)
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json | jq .dist.attestations

# Cross-reference SBOM
gh run download --repo mindstone/mcp-servers --name <connector>-<X.Y.Z>-sbom
```

A signature verification failure on a `@mindstone/mcp-server-*` version is treated as an incident: trigger the EMERGENCY_REVOKE runbook even if the package appears to function correctly. A missing `dist.attestations` on a version that the publish workflow claims to have published indicates the version was pushed through a non-trusted-publisher path (manual `npm publish` from a workstation, e.g.) and must be investigated before being trusted.

## Cross-references

- [Threat model + audit findings](security/AUDIT_FOX-3319_tanstack_supply_chain.md) — why this gate exists in its current form
- [Branch + tag protection settings](security/BRANCH_PROTECTION.md) — the repo-side preconditions the trusted-publisher binding relies on
- [Emergency revoke runbook](EMERGENCY_REVOKE.md) — what to do when verification fails
- [Migration runbook (legacy scope cutover)](../MIGRATION.md) — the one-shot operations behind the current `@mindstone/` posture; the dual-publish + deprecate procedure for the legacy `@mindstone-engineering/*` scope is in step 4
- [Repository security policy](../SECURITY.md)
- Connector-specific publish history: each connector's `CHANGELOG.md`
- [Release process for contributors](../CONTRIBUTING.md#release-process) — the bump-and-CHANGELOG workflow the PR check enforces
