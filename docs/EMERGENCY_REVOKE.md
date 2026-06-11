# Emergency Revoke Runbook

What to do when a published connector version on npm is found to contain a security defect, leaked credential, or supply-chain compromise.

This document captures the **decision tree** and **operational steps** so a maintainer on call can act without re-deriving the protocol from scratch.

## Decision Tree

```
Defect discovered in published version
│
├─ Is it within 72 hours of publish?
│  ├─ YES → npm unpublish window is open. Prefer SUPERSEDE-then-DEPRECATE
│  │        (publish a fixed patch, then deprecate the bad version).
│  │        Unpublish is a last resort — it breaks lockfile integrity for
│  │        every consumer who already installed the bad version.
│  │
│  └─ NO  → Unpublish window is closed (npm policy). The only options are
│            DEPRECATE + SUPERSEDE.
│
├─ Is the defect a credential leak (token, key, signing secret)?
│  ├─ YES → ROTATE THE CREDENTIAL FIRST (see Credential Rotation below).
│  │        Then deprecate. Then publish a fixed version. Order matters —
│  │        deprecation alone does not protect a leaked credential.
│  │
│  └─ NO  → Skip credential rotation; proceed to deprecate + supersede.
│
└─ Is the defect a supply-chain compromise (signed-but-malicious release)?
   └─ YES → Treat as P0. Page the named maintainer. Disable the package's
            Trusted Publisher binding at npmjs.com (there is no npm token
            to revoke — publishing is OIDC-only) and revoke any stray npm
            automation tokens found. Audit Sigstore attestations for the
            affected package on https://search.sigstore.dev. Open an
            incident channel in #security and follow the standard incident
            playbook before any further publishes from this repo.
```

## Standard Operations

### Deprecate a version (preferred path)

```bash
npm deprecate '@mindstone/mcp-server-<connector>@<version>' \
  'SECURITY: <one-line summary>. Upgrade to <fixed-version> immediately. See https://github.com/mindstone/mcp-servers/security/advisories/<advisory-id>'
```

This adds a deprecation warning visible to every consumer running `npm install`. It does NOT remove the tarball — old lockfiles continue to resolve to the same bytes — but it makes the warning loud and gives upgrade guidance.

### Supersede with a patch

1. Land the fix in `connectors/<connector>/` on `main` (code-only — no version change; record the fix as a `### Security` entry under `## [Unreleased]` in `CHANGELOG.md`).
2. Release it via the release tooling: `npm run mcp:release <connector>` from the Mindstone Rebel repo. This is the emergency path too — it bumps every version surface in lockstep, promotes the changelog, and stamps the `Release-Gate` trailer that `.github/workflows/release.yml` requires before publishing. A hand-pushed bump without the trailer will be **refused** by the release workflow and slow you down mid-incident.
3. The Release workflow ships the patch with `--provenance` via Trusted Publishing and posts the publish alert to Slack.
4. Verify on npm: `npm view @mindstone/mcp-server-<connector>@<new-version>` shows the new version with the published Sigstore attestation.

### Unpublish (last resort, ≤72h only)

```bash
npm unpublish '@mindstone/mcp-server-<connector>@<version>'
```

Only acceptable when:
- Less than 72 hours since publish
- The published tarball contains a leaked credential or remotely exploitable defect
- A simultaneous superseding publish is queued
- The named maintainer has approved

After 72 hours, npm policy prohibits unpublish to protect ecosystem integrity. Do not file a manual unpublish request unless the security incident warrants it.

## Credential Rotation

When a published version exposes a credential, rotate before deprecating:

| Credential | How to rotate |
|---|---|
| npm publisher account | Revoke any active automation tokens at https://www.npmjs.com/settings/<user>/tokens. Manual publishes (see `docs/PUBLISH_APPROVAL_PROCESS.md`) use WebAuthn 2FA rather than a long-lived `NPM_TOKEN`; if a stale `NPM_TOKEN` exists in repo secrets, revoke it both on npm and on GitHub (`gh secret delete NPM_TOKEN --repo mindstone/mcp-servers`) — manual-publish mode does not consume it. |
| Connector OAuth client secret (e.g. Slack `clientSecret`) | Rotate at the provider's dev console (Slack: api.slack.com/apps/<id>/general → Regenerate). Update `EMBEDDED_CREDENTIALS` in the host repo and ship a host release. **All issued bot tokens remain valid** — the secret is used only for new OAuth flows. |
| Slack signing secret (webhook adapter) | Rotate at api.slack.com/apps/<id>/general. Update `SLACK_SIGNING_SECRET` in cloud-service env and redeploy. **All in-flight webhook deliveries from before rotation will fail signature verification** — accept this as the cost of rotation. |
| User bot tokens (`xoxb-...` / `xoxp-...`) | These are not embedded in packages. Rotation happens automatically via refresh-token rotation on next API call (or user re-auth if rotation isn't enabled). No package-side action required. |

## Audit / Disclosure

After a deprecation lands:

1. Open a GitHub Security Advisory at https://github.com/mindstone/mcp-servers/security/advisories so consumers using `npm audit` see the CVE.
2. Update the connector's `CHANGELOG.md` `### Security` section with the advisory ID.
3. Notify the host (MindstoneRebel) team via the standard cross-repo dispatch — the catalog-sync workflow handles version pinning automatically once the host catalog is updated to point at the patched version.

## Named Maintainers

| Connector | Maintainer | Backup |
|---|---|---|
| slack | TBD on first publish — assigned in the publish-approval issue | TBD |
| hubspot | TBD | TBD |
| (others) | See connector-specific README | |

The named maintainer for a connector is the human who approves a publish, holds the WebAuthn 2FA recovery codes for the npm publisher account, and is paged on a security incident. Maintainership is recorded in the publish-approval GitHub issue at the time of each release.

## References

- npm unpublish policy: https://docs.npmjs.com/policies/unpublish
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- Sigstore search: https://search.sigstore.dev
- This repo's security policy: [SECURITY.md](../SECURITY.md)
