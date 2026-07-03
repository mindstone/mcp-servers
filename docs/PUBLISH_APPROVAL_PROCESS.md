# Publish Approval Process

Every connector publish to npm under `@mindstone/mcp-server-*` is gated. This document defines the gate chain.

> **Architecture mode (since 2026-06-11, AI-only release policy):** Releases are driven end-to-end by the release tooling (`npm run mcp:release <connector>` in the Mindstone Rebel repo) and published by CI (`.github/workflows/release.yml`, Trusted Publishing OIDC). The approval model is a **machine-validated, AI-reviewed gate chain** — there is deliberately **no human-click approval step** on the publish path (the `npm-publish` GitHub environment has no required reviewers, by design). The previous models — manual WebAuthn `npm publish` from the wave-lead's machine (2026-05-17 pivot), then the allowlist-scoped Trusted Publishing carve-out (2026-05-29) — are superseded for everyday releases; the manual path survives only for first publishes (bootstrap). Commit history preserves the earlier revisions of this document.

## The gate chain (per connector, per version)

A release reaches npm only by passing all of these, in order:

1. **Source-level security review (§13), AI-authored with a cross-family adversarial pass.** Before any bump lands, the release tooling requires a review artifact at `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md` in the consuming Rebel repo, built from the template at `docs-private/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md`. The artifact carries a machine-readable release-gate block (version, open critical/high findings = 0, authorship/authorization fields) that the tooling validates before proceeding. Policy requirements: the adversarial reviewer must be a **different model family** than the author/implementer, must read the diff and the full relevant source, and must record model ID, session ID, and confidence in the artifact.
2. **The `Release-Gate` trailer on the release commit.** The release tooling stamps every release commit with
   `Release-Gate: docs-private/reports/security-reviews/<file>.md#<sha256>`
   — the path of the review artifact and the SHA-256 of its content. `.github/workflows/release.yml` refuses to publish any version bump whose attributed commit lacks a trailer in valid format (this repo is public, so CI validates **format only**: no secrets, no private-repo lookups). A bump that lands without the trailer fails the release run loudly and publishes nothing.
3. **Rebel-side trailer audit.** The Rebel repo verifies that the trailer's `<path>#<sha256>` matches the actual private review artifact for the pinned release commit — closing, as far as possible without putting secrets on a public repo, the gap left by format-only validation in CI.
4. **Trusted Publishing + provenance.** `release.yml` publishes with OIDC (no `NPM_TOKEN` anywhere), `--ignore-scripts`, and `--provenance` Sigstore attestations; consumers verify via `npm audit signatures`. The repo-root `.npmrc` `min-release-age=7` cool-down gives consumers a recall window. This — not the trailer — is the adversarial-security layer; the trailer is an accident/consistency gate.
5. **Publish alerting.** After every npm publish, `release.yml` posts a Slack message (same channel as commit/PR notifications) with `connector@version`, the attributed release commit, the actor, and the run URL — an unexpected publish is human-visible same-day without anyone polling npm.

Structural complements that keep the chain gate-complete:

- **No version bumps in PRs.** A required PR check (`.github/workflows/version-bump-guard.yml`) fails any PR that changes an existing connector's or `packages/*` package's version, so a PR merge can never be a surprise publish trigger. See `CONTRIBUTING.md` → Release process → The landing rule.
- **Version-surface lockstep + artifact regeneration** are done by the release tooling itself (connectors: `package.json`, `package-lock.json`, `server.json`, catalogue, install-links — STATUS.json stores no version under schema v2; shared libraries: `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md` via `--base-dir packages`), with CI drift checks as backstop. Shared-library releases skip MCP-registry publish (no `server.json`). Canonical runbook: `docs/project/MCP_OSS_RELEASE_AGENT_DRIVEN.md` in the Mindstone Rebel repo.
- **Post-publish verification** (npm version visible, `npm audit signatures`, MCP-registry entry, smoke run) is part of the release tooling's pipeline, not an optional manual step.

## Why no human gate?

Decision (2026-06-11): the team wants a careful, trustworthy, consistent **AI-only** process rather than a human-click bottleneck. The properties the old human gates provided are replaced by construction:

- *"A human read the changes"* → the §13 review with a mandatory cross-family adversarial pass (two independent model families over the same diff + source), machine-validated for completeness.
- *"A human chose to publish"* → only the release tooling can produce a publishable commit (trailer gate); the tooling's own invocation is the deliberate act, and it runs interactive push approvals on the Rebel side.
- *"A human would notice a bad publish"* → publish alerting (gate 5) plus the `min-release-age=7` consumer cool-down, plus `EMERGENCY_REVOKE.md` for recall.

What this model does **not** claim: the trailer gate does not stop a malicious actor with push access to `main` — it is format-validated on a public repo. The adversarial layers remain Trusted Publishing (no stealable token), Sigstore provenance, `min-release-age`, and the Rebel-side audit; catalog pinning on the Rebel side means a forged npm publish alone never reaches Rebel users.

**Deferred hardening (with re-open signals):** signed release commits would add an out-of-band-credential property on top of the trailer. Deferred for now (key-management overhead vs a two-maintainer team). Re-open on: external-contributor volume growth, any credential-compromise scare, or the OSS-launch readiness review.

## First publishes (bootstrap) — the manual path

`release.yml` can only publish packages that already have Trusted Publishing configured on npm. A brand-new connector's **first** publish is a manual maintainer ceremony, and the old human-gated checklist applies to it. The same applies to the **first provenance-backed publish** of a `packages/*` shared library (bootstrap `0.x` may have been manual without Sigstore; bind Trusted Publishing before the first `mcp:release` publish). See the Rebel manual runbook (`docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md` § Shared libraries).

1. Land the new connector (PR with version surfaces set in lockstep — see `CONTRIBUTING.md` → First publish of a new connector). The version-bump guard exempts packages that are new at the PR base.
2. Pre-publish checklist (record in a tracking issue `Publish approval: <connector> v<X.Y.Z>`):
   - [ ] Security review artifact exists in the Rebel repo for this exact `<connector>@<version>` (same §13 artifact as gate 1 above).
   - [ ] Tarball clean: `npm pack --dry-run --ignore-scripts` shows no `.map`, no `.test.` / `__tests__/`, no nested `.tgz`, no `.env*`, no `.npmrc`, no raw `.ts` source.
   - [ ] `npm audit`: 0 critical / 0 high / 0 moderate on `--omit=dev`, or named risk owner per remaining moderate.
   - [ ] `CHANGELOG.md` has the `[<X.Y.Z>] - <date>` section with honest content.
   - [ ] Version sync across `package.json`, `package-lock.json` (top-level + `packages[""]`), `server.json` (top-level + `packages[0]`). (`STATUS.json` stores no version under schema v2 — `check-status.mjs` rejects one.)
   - [ ] `package.json.name` is exactly `@mindstone/mcp-server-<directory-slug>`.
3. `npm publish --access=public` — interactive WebAuthn prompt on the publisher account (`mindstone-engineering`; WebAuthn-only 2FA, no automation tokens on the scope).
4. Configure Trusted Publishing for the package at npmjs.com (binds it to `release.yml` on this repo) so every subsequent release flows through the standard gate chain.
5. Smoke: `npm view @mindstone/mcp-server-<connector> version`, then `npx -y @mindstone/mcp-server-<connector>` initialize handshake.

## Hygiene (quarterly review)

Owner: the maintainers (`@mindstone/oss-maintainers`).

- Confirm Trusted Publishing bindings: every published `@mindstone/mcp-server-*` package's publisher config points at `mindstone/mcp-servers` + `release.yml`. A binding pointing anywhere else is an incident.
- Confirm no `NPM_TOKEN` (or other npm automation token) lives in `Settings → Secrets and variables → Actions`. Trusted Publishing needs none; the existence of one is a red flag — revoke and investigate.
- Confirm npm org-level 2FA is still enforced and the publisher account is WebAuthn-only.
- Confirm the `npm-publish` GitHub environment still has the expected (empty-by-design) reviewer configuration — and that this document still reflects the policy if that ever changes.
- Spot-check the last few releases: each release commit on `main` carries a `Release-Gate` trailer whose artifact exists in the Rebel repo with a matching hash.
- Confirm `.npmrc` still pins `min-release-age=7` (security invariant — see `AGENTS.md`).

## Cross-references

- [Release process + the landing rule](../CONTRIBUTING.md#release-process) — what lands via PR vs via the release tooling
- [Branch + tag protection posture](security/BRANCH_PROTECTION.md) — the repo-side settings, documented honestly
- [Threat model + audit findings (historical)](security/AUDIT_FOX-3319_tanstack_supply_chain.md) — the threat model remains valid; its recommendation table predates the AI-only pivot
- [Emergency revoke runbook](EMERGENCY_REVOKE.md) — what to do when a published version turns out to be compromised
- [Migration runbook (legacy scope cutover)](../MIGRATION.md) — post-wave deprecation of `@mindstone-engineering/*`
- [Repository security policy](../SECURITY.md)
- Release tooling SSOT: `docs/project/MCP_OSS_RELEASE_AGENT_DRIVEN.md` in the Mindstone Rebel repo (private)
