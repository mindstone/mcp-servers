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

- **Human chain of custody on every release**: every `@mindstone/mcp-server-*` version is published from the named wave-lead's dev machine, behind a hardware-key (WebAuthn) 2FA challenge. See [docs/PUBLISH_APPROVAL_PROCESS.md](docs/PUBLISH_APPROVAL_PROCESS.md) for the per-release human gate that every publish runs through.
- **`min-release-age` cool-down**: new releases are not installable by name for 7 days after publish; consumers running `npm install` with `min-release-age` enforcement (npm ≥ 11.10) get an automatic incident window before a freshly compromised version can reach their lockfiles. See [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md) for the rationale.
- **No behaviour change**: this is a scope rename plus a patch bump. The tool names, parameters, return shapes, and required env vars are identical.

> **Note on provenance attestations:** Earlier revisions of this document promised Sigstore provenance attestations on every release. The CI-based OIDC publish path that would have produced those attestations was retired during FOX-3319 (see [docs/PUBLISH_APPROVAL_PROCESS.md](docs/PUBLISH_APPROVAL_PROCESS.md)). Consumers who want a provenance chain today get the human-verifiable equivalent: the published tarball's shasum can be reproduced by checking out `mindstone/mcp-servers` at the release commit and running `npm pack` locally.

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

A failed signature verification on `@mindstone/`'s npm registry signing means the registry record has been tampered with and should not be trusted; report it to [security@mindstone](mailto:security@mindstone) (see [SECURITY.md](SECURITY.md)). Provenance attestations (Sigstore-signed) are **not** produced for manual publishes; see the note above.

---

## For maintainers

The npm-side migration is a three-step procedure per package. The repo-side migration has already landed in commits A–E (rename, CHANGELOG backfill, patch bump, PR check, manual-publish pivot). What follows is the work that has to happen on registry.npmjs.org from the wave-lead's dev machine plus a few GitHub org settings.

### Pre-flight checklist (one time)

- [x] CODEOWNERS team `@mindstone/oss-maintainers` exists (closed 2026-05-17, id 17581413, member: `harryblam`). Replace placeholder maintainer roster with the real list before Phase 3.
- [x] `.github/workflows/publish.yml` removed (PR #32 merged 2026-05-17). No CI publish path exists; do not resurrect without revisiting the audit doc.
- [ ] Enable branch protection on `main` and tag protection on `*-v*` per `docs/security/BRANCH_PROTECTION.md`. (Settings drift check: re-run §5 verification commands in that doc.)
- [ ] Verify the npm publisher account has 2FA enabled (`npm whoami` → expected `mindstone-engineering`; 2FA mode is WebAuthn-only at time of writing). This account is the single point of authority for every `@mindstone/mcp-server-*` publish.
- [ ] Confirm `NPM_TOKEN` repo secret is NOT present (`gh secret list --repo mindstone/mcp-servers | grep NPM_TOKEN`). Manual-publish mode does not use long-lived publish tokens; if one exists, revoke it.
- [ ] Read `docs/PUBLISH_APPROVAL_PROCESS.md` end-to-end. The wave-lead must understand the pre-publish checklist for each connector.
- [ ] Read `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` for the per-connector target versions + the canonical runbook.

### Per-package step 1 — Bootstrap publish on `@mindstone/`

For each of the 24 connectors that still need a publish under the new scope (see the table in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md` for the current state), run the canonical procedure from the wave-lead's dev machine:

```sh
cd connectors/<connector>
# Run the G6 pre-flight (build + test + audit + pack-scan):
npm ci --ignore-scripts && npm run build && npm test \
  && npm audit --omit=dev --audit-level=high \
  && npm pack --dry-run --ignore-scripts

# When everything is clean, publish. WebAuthn 2FA prompt fires in the system browser:
npm publish --access=public --provenance=false
```

`--access=public` is required for first-time publishes under the new scope. `--provenance=false` is explicit because no GitHub Actions OIDC token is being minted — manual publishes cannot produce provenance attestations.

After the publish lands, fire the catalog-sync dispatch to Rebel:

```sh
cd /Users/<you>/development/mcp-servers
MAIN_SHA=$(git rev-parse origin/main)
gh api repos/mindstone/MindstoneRebel/dispatches \
  --method POST \
  -f event_type=connector-published \
  -F "client_payload[connector]=<connector>" \
  -F "client_payload[package]=@mindstone/mcp-server-<connector>" \
  -F "client_payload[version]=<X.Y.Z>" \
  -F "client_payload[sha]=$MAIN_SHA"
```

Verify the publish landed cleanly:

```sh
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> version
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json | jq '.dist.shasum'
```

The shasum should match the `shasum` line printed by `npm publish`. Provenance attestations under `.dist.attestations` will be **null** — that is expected; do not treat null as failure.

### Per-package step 2 — Dual-publish and deprecate `@mindstone-engineering/*`

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

### Per-package step 3 (post-window) — Lock down the legacy scope

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
| 2026-05-17   | Catalog backfill (PR #31), manual-publish pivot (PR #32, removes `publish.yml`), Phase 0 implementer guide handed to Rebel    | done   |
| 2026-05-17+  | Phase 2 — bootstrap publishes from wave-lead's dev machine for the 24 connectors not yet on `@mindstone/`                     | tbd    |
| 2026-05-17+  | Phase 3 — dual-publish + deprecate every legacy `@mindstone-engineering/mcp-server-*` package                                 | tbd    |
| 2026-08-14   | Window closes; legacy-scope publish rights revoked (90-day transition from initial wave start)                                | tbd    |

The 90-day window is calibrated to the longest realistic CI cadence on the consumer side: hosts that publish quarterly need at least one quarter to fold in the rename without being blocked by an emergency.

---

## Troubleshooting

**`npm publish` fails with `403 Forbidden`**
The publisher account has lost write access on the `@mindstone/` scope, or the local `npm whoami` is not the expected publisher account. Re-run `npm login`; complete the WebAuthn challenge if prompted. If still failing, an org-admin needs to re-grant `publish` on `@mindstone:developers` to `mindstone-engineering`.

**`npm view <pkg>@<ver> --json | jq .dist.attestations` returns null**
Expected in manual-publish mode. Provenance attestations are not produced for local `npm publish` runs. This is not a failure — see the note in [What you get on the new scope](#what-you-get-on-the-new-scope).

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
