# Publish Approval Process

Every connector publish to npm under `@mindstone/mcp-server-*` is gated on an explicit human approval recorded in this repo. This document defines the gate.

## Why a human gate?

npm tokens are automation-type (publish-only, no 2FA prompt) so the workflow can run unattended. That removes the 2FA friction but also removes the 2FA failsafe. The human gate is what stands in for it.

## Pre-publish checklist (per connector, per version)

Before tagging `<connector>-v<X.Y.Z>`, confirm in a tracking issue titled `Publish approval: <connector> v<X.Y.Z>`:

- [ ] **Source-level security review:** § 13 review run with at least 2 independent reviewers; all CRITICAL and HIGH findings either resolved or explicitly accepted with named risk owner.
- [ ] **Live runtime probe:** `npm run probe:live:gate` PUBLISH-GATE OK against a real workspace (the package's binary, not just unit tests).
- [ ] **Tarball clean:** `npm pack --dry-run --ignore-scripts` shows no `.map`, no test fixtures, no `.tgz`, no `.env`/`.npmrc`, no source `.ts` files.
- [ ] **`npm audit`:** 0 critical / 0 high / 0 moderate (or each remaining finding has a named risk owner).
- [ ] **CHANGELOG.md:** `[<X.Y.Z>] — <date>` section present and describes user-facing changes + security-relevant changes.
- [ ] **Version sync:** `package.json#version`, `src/server.ts` `version: '...'`, and the proposed git tag all match.
- [ ] **Named maintainer on call:** A human takes ownership of the version for the next 7 days for security response. This human's name + GitHub handle are recorded in the issue.
- [ ] **Publisher set documented:** The npm package's `maintainers` list on npm matches the named maintainer + at least one backup. Verify with `npm view @mindstone/mcp-server-<connector> maintainers`.
- [ ] **Approval recorded:** A separate human (not the author of the release commit) leaves a `LGTM — approve publish` comment on the tracking issue.

## What `--provenance` gives us (and doesn't)

- **Gives:** A Sigstore-signed attestation linking the published tarball to this repo, this commit, this workflow run. Anyone can verify with `npm audit signatures` or by inspecting the signature at https://search.sigstore.dev.
- **Doesn't give:** Defense against a compromised `NPM_TOKEN`. If an attacker steals the GitHub Actions token they can publish a signed-but-malicious release. The named maintainer + 7-day on-call window is the human-side mitigation; provenance is the verifier-side mitigation.

## Token hygiene

- The `NPM_TOKEN` GitHub secret must be an **automation** token (publish-only, no read/write of metadata).
- Tokens older than 90 days must be rotated.
- The list of tokens is reviewed quarterly by the named maintainer for `_template/` (currently: TBD).

## SBOM and provenance verification

After every publish, the workflow uploads a CycloneDX SBOM as a workflow artifact (365-day retention). To verify a published version:

```bash
# Verify Sigstore attestation
npm audit signatures @mindstone/mcp-server-<connector>@<X.Y.Z>

# Inspect provenance JSON
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json | jq .dist.attestations

# Cross-reference SBOM
gh run download --repo mindstone/mcp-servers --name <connector>-<X.Y.Z>-sbom
```

## Cross-references

- Emergency revoke runbook: [EMERGENCY_REVOKE.md](./EMERGENCY_REVOKE.md)
- Repository security policy: [../SECURITY.md](../SECURITY.md)
- Connector-specific publish history: each connector's `CHANGELOG.md`
