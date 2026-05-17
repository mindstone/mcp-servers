# `@mindstone/` scope finalisation — kickoff checklist

> **SUPERSEDED (2026-05-17)**: The CI-publish gates (G1, G4) collapsed when `publish.yml` was retired. The current pre-flight gate set is in the Phase 0 implementer guide (now living in `mindstone/MindstoneRebel`); the bootstrap-publish procedure is in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`. This checklist is preserved for historical context.

**Wave start date**: _____________  **Wave lead**: _____________

One-page action gate. Each row maps to a fuller description in `260515_finalise_mindstone_scope_publish.md` (this repo) or `260515_rebel_catalog_handoff.md` (Rebel coordination).

## Day -7 — Pre-flight gates (no publishes yet)

- [ ] **G1** `npm-publish` GHA environment exists with ≥1 required reviewer (not author of any release commit) — verify in repo Settings → Environments
- [ ] **G2** `CATALOG_SYNC_TOKEN` secret set, fine-grained PAT scoped to `mindstone/MindstoneRebel` only — `gh secret list --repo mindstone/mcp-servers`
- [ ] **G3** `@mindstone/oss-maintainers` team resolves OR CODEOWNERS edited to name explicit users — `gh api orgs/mindstone/teams/oss-maintainers`
- [ ] **G4** Trusted-publisher bindings either pre-existing on all 24 new-scope packages OR phase 2 bootstrap planned (path A)
- [ ] **R1** Synthetic-dispatch smoke test against `rebel-oss-catalog-sync.yml` produces a green workflow run
- [ ] **R2** Rebel sync workflow checks out `mindstone/mcp-servers` (not legacy org) — confirmed in workflow file
- [ ] **R3** Rebel `dev` branch protection allows `peter-evans/create-pull-request` to push `catalog-sync/*` branches
- [ ] **R5 step 1 (load-bearing)** Office tolerant-locator PR merged on Rebel `dev`. Confirm `OFFICE_MCP_PACKAGE_PATH_SEGMENTS` accepts both legacy and new scope.
- [ ] **R7 (load-bearing)** Rebel `import-rebel-oss-catalog-entry.ts` patch merged on `dev`. `buildCatalogEntry` conditionally sets fields; `upsertEntry` does a generic preserve-all-unspecified shallow merge. Regression test asserts setupFields.envVar / setupUrl / setupInstructions / callbackUrl / accountIdentity / platforms / contributors all survive an upsert. Verified via R1 synthetic dispatch — produces a clean `mcpConfig.args` + `verifiedSource` diff only.

## Day -3 — Phase 1 mcp-servers repo prep (single PR)

Per B3 Option A v2: manifests carry ONLY the required base fields (id, name, description, category, icon, maturity, verifiedSource, requiresSetup). They do NOT carry `setupFields` or `accountIdentity` — those stay in the Rebel catalog as canonical and are preserved through the R7-patched upsert.

- [ ] 20 new `catalog-entry.json` files added (minimal-shape, base fields only, `id: "bundled-<connector>"`)
- [ ] 6 existing `catalog-entry.json` files re-written to the minimal shape — id normalised to `bundled-<connector>`, `verifiedSource` set to `"https://github.com/mindstone/mcp-servers"`, stale `setupFields`/`accountIdentity` removed
- [ ] `email-imap/catalog-entry.json` uses `id: "bundled-custom-email"` (E1)
- [ ] `apple-shortcuts/catalog-entry.json` uses `requiresSetup: false`
- [ ] `office/catalog-entry.json` uses `requiresSetup: false`
- [ ] `hubspot/catalog-entry.json` uses `requiresSetup: false` (existing entry has `undefined`; `false` is semantically equivalent and validator-required)
- [ ] `.github/ISSUE_TEMPLATE/publish-approval.yml` added (standard PUBLISH_APPROVAL_PROCESS.md checklist)
- [ ] Each manifest's `name`, `description`, `category`, `icon`, `maturity`, `requiresSetup` exactly matches the existing `bundled-<connector>` entry in Rebel's `resources/connector-catalog.json` (Option A v2 still overwrites these fields verbatim from manifest)
- [ ] Local dry-run of Rebel's R7-patched `import-rebel-oss-catalog-entry.ts` against each manifest produces a single-line diff (just `mcpConfig.args[-1]`); `setupFields` and `accountIdentity` are unchanged in the dry-run output
- [ ] PR reviewed under CODEOWNERS gate, merged to `main`

## Day -1 — Phase 2 bootstrap publishes (one human, 2FA, ~2h serial)

For each of `slack` + 23 others (skip `hubspot`, `apple-shortcuts`):

- [ ] `npm publish ./*.tgz --access public --tag bootstrap` succeeds
- [ ] `npm deprecate <pkg>@0.0.0-bootstrap.0 'Bootstrap placeholder, do not install. Real release at <X.Y.Z>.'`
- [ ] Trusted Publisher configured on `npmjs.com/.../access` — repo `mindstone/mcp-servers`, workflow `publish.yml`, environment `npm-publish`
- [ ] `npm view @mindstone/mcp-server-<c> versions` returns ≥1 result
- [ ] `npm view @mindstone/mcp-server-<c> dist-tags` shows NO `latest` (only `bootstrap`)

## Day 0 — Phase 3 OIDC release wave

**Phase 3.0** Apple-shortcuts catch-up (already published 0.1.2):
- [ ] Synthetic dispatch fired: `gh api repos/mindstone/MindstoneRebel/dispatches -f event_type=connector-published -f client_payload[connector]=apple-shortcuts ...`
- [ ] Rebel auto-sync PR opened, reviewed via W2, merged

**Phase 3.1** Sub-wave A (`fathom`, `humaans`, `pandadoc`, `talentlms`, `slack`):
- [ ] 5 tags pushed (`<connector>-v<X.Y.Z>`)
- [ ] 5 publishes approved via `npm-publish` environment gate
- [ ] `npm audit signatures` clean for all 5
- [ ] 5 catalog-sync PRs opened on Rebel `dev`, reviewed, merged
- [ ] **STOP CONDITION**: if any signature fails or sync PR doesn't open within 10 min — HALT, triage before continuing

**Phase 3.2** Sub-wave B (16 connectors, days 2-3, batched 4-6 at a time):
- [ ] `elevenlabs` `freshdesk` `gamma` `google-analytics` tagged + verified + Rebel PRs merged
- [ ] `kling` `mixmax` `nano-banana` `napkin` tagged + verified + Rebel PRs merged
- [ ] `outreach` `quickbooks` `retell-ai` `runway` tagged + verified + Rebel PRs merged
- [ ] `servicenow` `workday` `zendesk` `browser-automation` tagged + verified + Rebel PRs merged

**Phase 3.3** Sub-wave C (3 high-touch, day 4+, serial):
- [ ] `salesforce-v0.1.2` tagged + verified + Rebel PR merged
- [ ] `office-v0.1.4` tagged + verified
  - [ ] Rebel R5 step 2+3 PR opened (version-bump + seed tarball + snapshots), merged on `dev`
  - [ ] Rebel auto-sync PR merged AFTER R5 step 2+3 in the same deploy window
  - [ ] Office sidecar smoke-tested on a local Rebel dev build
- [ ] `email-imap-v0.2.3` tagged + verified + Rebel auto-sync PR (bundled-custom-email) merged
  - [ ] W4-email-imap manual M1 PR opened for `bundled-icloud-mail` + `bundled-yahoo-mail`, merged in same deploy

## Day 0+ — Phase 4 legacy cleanup (one human, 2FA, ~70 min serial)

- [ ] Dual-publish 23 connectors under `@mindstone-engineering/` (skip slack; apple-shortcuts optional)
- [ ] `npm deprecate '@mindstone-engineering/mcp-server-<c>@*'` for all 25 (skip slack only)
- [ ] `npm view @mindstone-engineering/mcp-server-<c> deprecated` shows migration message per connector

## Day 0+ — Verification + handoff

- [ ] **Phase 5** Scripted per-connector verification clean (version, attestations, signatures, legacy deprecation)
- [ ] **Rebel P1** catalog audit script confirms 100% `@mindstone/...` for rebel-oss provider entries
- [ ] **Rebel P2** Quarantine telemetry watch active for 7 days; named on-call maintainer staffed
- [ ] End-of-wave summary posted in Rebel maintainer channel
- [ ] Calendar reminder set for **2026-08-14** (MIGRATION.md step 5 — legacy scope lockdown)

## Rollback triggers (any of these → STOP wave, follow EMERGENCY_REVOKE.md)

- Signature verification fails on a `@mindstone/` version
- Dispatch-catalog-sync job fails for 3+ consecutive publishes (token / workflow regression)
- Office sidecar quarantine telemetry spikes after sub-wave C step 2
- Two or more catalog-sync PRs land with diffs touching unexpected fields (curation, bundledConfig, tools)

## Quick references

- Full plan: `docs/plans/260515_finalise_mindstone_scope_publish.md`
- Rebel handoff: `docs/plans/260515_rebel_catalog_handoff.md`
- Per-release gate: `docs/PUBLISH_APPROVAL_PROCESS.md`
- Rollback runbook: `docs/EMERGENCY_REVOKE.md`
- Original scope migration: `MIGRATION.md`
- Manual flip template (M1): Rebel commits `92e9a6506` (provider flip), `0cfce86db` (scope flip)
