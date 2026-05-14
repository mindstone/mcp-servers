# Migration: `@mindstone-engineering/*` → `@mindstone/*`

This document is the single source of truth for the npm-scope migration that landed under the FOX-3319 supply-chain hardening work. Every MCP-server package previously published under the `@mindstone-engineering/` npm scope is being republished under the shorter `@mindstone/` scope. The two scopes will run side-by-side for a deprecation window; after the window closes the old scope will be locked down.

If you are a consumer (host, agent runtime, end user), skip to [For consumers](#for-consumers).

If you are a maintainer, the [For maintainers](#for-maintainers) section is the runbook you need to execute exactly once per package, in order.

---

## For consumers

### TL;DR

Replace every reference to `@mindstone-engineering/mcp-server-<connector>` with `@mindstone/mcp-server-<connector>`. The set of connectors, the tool surface, and the configuration env vars are unchanged.

```diff
-npx -y @mindstone-engineering/mcp-server-zendesk
+npx -y @mindstone/mcp-server-zendesk
```

```diff
 {
   "mcpServers": {
     "zendesk": {
       "command": "npx",
-      "args": ["-y", "@mindstone-engineering/mcp-server-zendesk"],
+      "args": ["-y", "@mindstone/mcp-server-zendesk"],
       "env": { "ZENDESK_API_TOKEN": "..." }
     }
   }
 }
```

### What you get on the new scope

- **Provenance attestations**: every release under `@mindstone/` ships an [npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements) signed by GitHub's OIDC issuer, bound to this repository and the `publish.yml` workflow. Verify with `npm audit signatures @mindstone/mcp-server-<connector>@<version>` and `npm view @mindstone/mcp-server-<connector>@<version> --json | jq .dist.attestations`.
- **`min-release-age` cool-down**: new releases are not installable by name for 7 days after publish; consumers running `npm install` with `min-release-age` enforcement (npm ≥ 11.10) get an automatic incident window before a freshly compromised version can reach their lockfiles. See [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md) for the rationale.
- **No behaviour change**: this is a scope rename plus a patch bump. The tool names, parameters, return shapes, and required env vars are identical.

### What happens to `@mindstone-engineering/*`

During the deprecation window (see [Timeline](#timeline) below) the old packages remain installable but are marked deprecated. `npm install @mindstone-engineering/mcp-server-<connector>` will print a warning pointing to the `@mindstone/` replacement. Existing lockfiles continue to resolve.

After the window closes, the `@mindstone-engineering/` scope's publish rights are revoked on the npm side. The packages remain on the registry (no unpublish — that would break downstream lockfiles) but no new versions can be cut. The deprecation message remains.

### Recommended consumer configuration

```ini
# .npmrc
audit=true
audit-level=high
# Hold off on freshly-published versions for 7 days; gives the maintainers
# time to react if a release turns out to have been compromised at publish
# time. Requires npm >= 11.10.
min-release-age=7
```

Hosts that pin versions explicitly should also verify provenance at install time:

```sh
npm install @mindstone/mcp-server-<connector>@<version>
npm audit signatures @mindstone/mcp-server-<connector>@<version>
```

A failed signature verification means the package was published outside the trusted-publisher binding and should not be trusted; report it to [security@mindstone](mailto:security@mindstone) (see [SECURITY.md](SECURITY.md)).

---

## For maintainers

The npm-side migration is a four-step procedure per package. The repo-side migration has already landed in commits A–D (rename, CHANGELOG backfill, patch bump, PR check). What follows is the work that has to happen on registry.npmjs.org and in the GitHub org settings.

### Pre-flight checklist (one time)

- [ ] Replace the `@mindstone/oss-maintainers` placeholder team slug in `.github/CODEOWNERS` with the real GitHub team. The slug must resolve before branch protection takes effect.
- [ ] Create the `npm-publish` GitHub Actions environment under repo Settings → Environments. Configure at least one required reviewer (a maintainer who is NOT the PR author). The publish job already declares `environment: npm-publish`; without the environment object the job has no required-approval gate.
- [ ] Enable branch protection on `main` and tag protection on `*-v*` per `docs/security/BRANCH_PROTECTION.md`.
- [ ] Verify the npm publisher account has 2FA enabled at the org level (`npm access list users mindstone`). The trusted-publisher OIDC path does not bypass this — 2FA still gates the manual deprecate/revoke commands below.
- [ ] Generate and revoke `NPM_TOKEN` in repo secrets only AFTER the first successful OIDC publish — the token is the legacy fallback and should not coexist with trusted publishing once OIDC works.

### Per-package step 1 — Bind the trusted publisher (new scope)

For each of the 26 connectors in `connectors/`, configure npm Trusted Publishing on `@mindstone/mcp-server-<connector>`:

1. Visit `https://www.npmjs.com/package/@mindstone/mcp-server-<connector>/access` (the package must exist; for the three connectors that have never been published — hubspot, slack, google-analytics — do step 2 first to create the package, then return here).
2. Click "Trusted Publisher" → "Configure"
3. Fill in:
   - **Repository**: `mindstone/mcp-servers`
   - **Workflow filename**: `publish.yml`
   - **Environment name**: `npm-publish`
4. Save.

This binding is what enables OIDC publishing in step 3.

### Per-package step 2 — Bootstrap publish (only for `hubspot`, `slack`, `google-analytics`)

These three were renamed from `@mindstone-engineering/` to `@mindstone/` before they were ever published, so the new-scope package does not exist on npm yet and trusted publishing has nothing to bind to. Bootstrap each one with a one-time local publish using an automation token + 2FA:

```sh
cd connectors/<connector>
npm pack --ignore-scripts          # produce the .tgz locally
npm publish ./*.tgz \
  --provenance \
  --access public
```

This requires the publishing user to have `publish` rights on the `@mindstone` scope and to complete a 2FA challenge. After the first successful publish, return to step 1 above and configure the trusted-publisher binding. From that point on, the next release flows through the automated `publish.yml` pipeline.

### Per-package step 3 — Cut the first OIDC release on `@mindstone/`

For every connector (not just the three above), tag the commit landed by Commit C with the connector-prefixed tag the publish workflow watches:

```sh
git checkout main
git pull
git tag <connector>-v<X.Y.Z>      # e.g. zendesk-v0.3.2
git push origin <connector>-v<X.Y.Z>
```

Pushing the tag triggers `.github/workflows/publish.yml`. The build job packs the tarball with `--ignore-scripts` and uploads it as an artifact; the publish job downloads the artifact and runs `npm publish <tarball> --provenance` only — no JS executes in the OIDC-bearing job. A maintainer reviewer must approve the `npm-publish` environment gate before publish runs.

Verify the publish landed cleanly:

```sh
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json \
  | jq '{version, dist:{integrity:.dist.integrity, attestations:.dist.attestations}, _hasShrinkwrap}'

npm audit signatures @mindstone/mcp-server-<connector>@<X.Y.Z>
```

A clean output should show one attestation under `dist.attestations` and `audit signatures` should report `Verified registry signatures, audited <N> packages` with zero unsigned.

### Per-package step 4 — Dual-publish and deprecate `@mindstone-engineering/*`

For every connector that has a published version under the legacy scope, ship the same release bytes once more under the legacy name so consumers who haven't migrated yet can still pull the latest fixed version without a name change:

```sh
# From the freshly-published artifact, retag and republish under the legacy scope.
cd /tmp && mkdir -p dual && cd dual
npm pack @mindstone/mcp-server-<connector>@<X.Y.Z>
tar -xzf mindstone-mcp-server-<connector>-<X.Y.Z>.tgz
cd package
# Edit package.json: name -> "@mindstone-engineering/mcp-server-<connector>"
# (leave everything else, including version, unchanged.)
sed -i.bak 's|"@mindstone/mcp-server-|"@mindstone-engineering/mcp-server-|g' package.json
rm package.json.bak
cd ..
tar -czf legacy-<connector>-<X.Y.Z>.tgz package
npm publish ./legacy-<connector>-<X.Y.Z>.tgz --access public
```

> Why not script this? The dual-publish is a one-shot per package and must complete a 2FA challenge each time. Doing it interactively is the audit-trail; an automated batch would dilute the human review at exactly the moment we want it.

Then immediately mark every version under the legacy scope as deprecated:

```sh
npm deprecate '@mindstone-engineering/mcp-server-<connector>@*' \
  'This package has moved to @mindstone/mcp-server-<connector>. See https://github.com/mindstone/mcp-servers/blob/main/MIGRATION.md'
```

The `*` selector covers every previously published version, including the one you just dual-published. The dual-publish exists so existing lockfiles can resolve `latest`; the deprecation message tells those installs they need to migrate.

### Per-package step 5 (post-window) — Lock down the legacy scope

After the deprecation window (see [Timeline](#timeline)) revoke the legacy scope's ability to receive new publishes:

```sh
# Remove every automation token bound to the legacy scope.
npm token list --json | jq '.[] | select(.scope=="@mindstone-engineering")'
npm token revoke <id>   # one per id above

# Remove every human publisher from the legacy scope.
npm access list users @mindstone-engineering --json
npm access revoke @mindstone-engineering:read-write <user>   # repeat per user
```

The packages remain on the registry forever (no unpublish — that would break downstream lockfiles and is also against the FOX-3319 audit guidance in `docs/EMERGENCY_REVOKE.md`). They simply cannot receive new versions. Combined with the `npm deprecate` already in place, this freezes the legacy scope at the dual-published version and gives forensic teams a stable reference if a compromise ever traces back through it.

---

## Timeline

| Date         | Phase                                                                                                                         | Status |
|--------------|-------------------------------------------------------------------------------------------------------------------------------|--------|
| 2026-05-14   | Repo migration commits A–E land (rename, CHANGELOG backfill, patch bump, PR check, MIGRATION.md)                              | done   |
| 2026-05-14+  | Maintainer ops: trusted-publisher bindings, npm-publish environment gate, branch protection, bootstrap publishes, OIDC tags   | tbd    |
| 2026-05-14+  | Dual-publish + deprecate every legacy `@mindstone-engineering/mcp-server-*` package                                           | tbd    |
| 2026-08-14   | Window closes; legacy-scope publish rights revoked (90-day transition)                                                        | tbd    |

The 90-day window is calibrated to the longest realistic CI cadence on the consumer side: hosts that publish quarterly need at least one quarter to fold in the rename without being blocked by an emergency.

---

## Troubleshooting

**`npm publish` fails with "Trusted publisher misconfigured"**
The package's trusted-publisher binding does not match the repo + workflow + environment combination. Verify on the package's `/access` page; the three fields must be exactly `mindstone/mcp-servers`, `publish.yml`, `npm-publish`.

**`npm audit signatures` reports `Verified registry signatures` but `dist.attestations` is empty**
The publish ran without `--provenance` or `NPM_CONFIG_PROVENANCE=true`. Re-publish with the env var set in the workflow step (it is in the current `publish.yml`; only relevant if a maintainer publishes by hand for the bootstrap step).

**The dual-publish fails with `403 Forbidden`**
The publishing user has lost write access to `@mindstone-engineering/`. This is expected after the lockdown step (step 5); if it happens before then, the access was revoked early and the deprecation message can be set without dual-publishing (consumers will see deprecation on whatever version they currently resolve, which is acceptable).

**A consumer reports `npm warn deprecated @mindstone-engineering/mcp-server-...` after the window closes**
Working as designed. The package still installs; the warning is the migration cue. If they need to silence it temporarily, they can pin to a specific version with `--no-fund --no-audit` in their host config, but the right answer is to flip their `npx -y` line to `@mindstone/`.

---

## Reference

- [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md) — threat model + remediation plan that motivated this migration
- [docs/security/BRANCH_PROTECTION.md](docs/security/BRANCH_PROTECTION.md) — the branch/tag protection settings the trusted-publisher binding relies on
- [docs/EMERGENCY_REVOKE.md](docs/EMERGENCY_REVOKE.md) — what to do if a `@mindstone/` release turns out to be compromised after publish
- [docs/PUBLISH_APPROVAL_PROCESS.md](docs/PUBLISH_APPROVAL_PROCESS.md) — the per-release human approval gate
- [CONTRIBUTING.md § Release process](CONTRIBUTING.md#release-process) — how new versions are cut going forward
