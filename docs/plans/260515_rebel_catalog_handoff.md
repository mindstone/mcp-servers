# Rebel catalog handoff — `@mindstone/` scope wave

> **Partially superseded (2026-05-17)**: The Rebel-side coordination contract (the R1–R7 gate set, the workflow filename, the catalog-sync dispatch payload shape) is **still valid**. Anything in this document that describes the **mcp-servers side** of the contract — particularly references to `.github/workflows/publish.yml` firing `repository_dispatch` automatically — is **superseded**: that workflow has been deleted. The dispatch is now fired manually from the wave-lead's dev machine after each `npm publish`, using the `gh api repos/mindstone/MindstoneRebel/dispatches` invocation documented in `docs/plans/260517_PHASE_2_BOOTSTRAP_PLAN.md`. The payload shape (`event_type=connector-published`, the four `client_payload` fields) is unchanged.

**Date**: 2026-05-15
**Owner (mcp-servers side)**: TBD — the named maintainer running `260515_finalise_mindstone_scope_publish.md`
**Owner (Rebel side)**: TBD — a Rebel maintainer with merge rights on `dev`
**Status**: planned, not started

This document is the coordination contract between the two repos for the FOX-3319 scope finalization wave. The mcp-servers side is owned by the sibling plan; this document describes what Rebel maintainers must do, in what order, with what evidence, and what to do when the automation diverges.

Read alongside [`260515_finalise_mindstone_scope_publish.md`](./260515_finalise_mindstone_scope_publish.md). The phase numbers here align with that plan.

---

## What Rebel currently expects from a successful mcp-servers publish

End-to-end happy path for a single connector:

1. mcp-servers pushes tag `<connector>-v<X.Y.Z>` on `main`.
2. `.github/workflows/publish.yml` builds, packs, mints OIDC token, runs `npm publish --provenance`.
3. The `dispatch-catalog-sync` job in the same workflow fires a `repository_dispatch` to `mindstone/MindstoneRebel` with event type `connector-published`, payload `{ connector, package, version, sha }`. The token used is the repo secret `CATALOG_SYNC_TOKEN`.
4. Rebel's `.github/workflows/rebel-oss-catalog-sync.yml` receives the dispatch, validates the payload, checks out `mindstone/mcp-servers` at the published SHA, reads `connectors/<connector>/catalog-entry.json`, runs `scripts/import-rebel-oss-catalog-entry.ts` to upsert the entry into `resources/connector-catalog.json`, and opens a `catalog-sync/<connector>` PR against `dev`.
5. A Rebel maintainer reviews the PR diff (single-line `mcpConfig.args[-1]` change in the happy case), merges to `dev`. The next dev build picks up the new package.

Three things can divert this happy path. The pre-flight section below resolves all three before the wave starts.

---

## Pre-flight (Rebel-side, before mcp-servers phase 2 begins)

### R1. Confirm `rebel-oss-catalog-sync.yml` still works end-to-end

Per the historical `docs/postmortems/260424_oss_catalog_sync_automation_never_worked_postmortem.md`, this workflow was broken in three independent ways. The 260424 fix-plan claimed to close all three, but neither `hubspot@0.1.2` nor `apple-shortcuts@0.1.2` produced a `catalog-sync/*` PR on Rebel — those were merged manually (e.g. commit `0cfce86db` for hubspot).

Verify with a synthetic dispatch:

```sh
gh api repos/mindstone/MindstoneRebel/dispatches \
  -f event_type=connector-published \
  -f client_payload[connector]=fathom \
  -f client_payload[package]=@mindstone-engineering/mcp-server-fathom \
  -f client_payload[version]=0.2.2 \
  -f client_payload[sha]=$(cd /path/to/mcp-servers && git rev-parse origin/main)
```

Watch `gh run list --workflow=rebel-oss-catalog-sync.yml --repo mindstone/MindstoneRebel` for a green run. If it stays red or no run appears, the dispatch path is still broken — block the wave until R1 is resolved.

The synthetic dispatch will fail at the `Verify catalog-entry.json exists` step if mcp-servers phase 1 hasn't merged yet — that's the intended state and is fine.

After verifying, close any auto-generated `catalog-sync/fathom` PR without merging (the synthetic payload references the legacy package name on purpose, to avoid polluting the real catalog).

### R2. Confirm the workflow checks out `mindstone/mcp-servers` at the dispatched SHA, not a stale fork

Read `.github/workflows/rebel-oss-catalog-sync.yml` and confirm the `Checkout mcp-servers at release SHA` step uses `repository: mindstone/mcp-servers`. Today (verified) it does. The PR body still links to `github.com/mindstone-engineering/mcp-servers/commit/<sha>` — that's a cosmetic stale reference that should be fixed but does not block the wave. Open a follow-up PR on Rebel to flip the body URL.

### R3. Confirm `dev` branch protection allows `peter-evans/create-pull-request` to push the sync branch

The workflow creates branches under `catalog-sync/<connector>`. Branch protection on `dev` must:

- Not require linear history (PR-bot commits are merge-commits in some configs)
- Not restrict pushes by user (the GitHub Actions bot must be allowlisted)
- Require review before merge (this is what makes the human gate effective)

Verify with `gh api repos/mindstone/MindstoneRebel/branches/dev/protection`.

### R4. Confirm the `import-rebel-oss-catalog-entry.ts` script preserves `bundledConfig` on upsert

The script (verified at `mindstone/MindstoneRebel/scripts/import-rebel-oss-catalog-entry.ts:212-225`) preserves `bundledConfig`, `tools`, and curation fields from the existing entry on upsert, and Rebel's `validateBundledConfigInvariant` guard fires before the catalog file is written.

Audit on 2026-05-15: 25 of 27 rebel-oss entries carry `bundledConfig` today. The two exceptions are `bundled-apple-shortcuts` and `bundled-hubspot` (`requiresSetup` undefined for hubspot, no `bundledConfig` for apple-shortcuts). The invariant guard is structured so it only fires on entries with `requiresSetup: true` AND non-empty `setupFields`, AND missing/malformed `bundledConfig`. For the 25 entries with `bundledConfig`, the preserve-on-upsert path keeps them invariant-clean as long as the mcp-servers manifest carries `requiresSetup: true` and a matching-length `setupFields` array. The mcp-servers phase 1.1 captures this requirement explicitly per connector.

### R5. Stage the Office package-constants PR (hard blocker B1 in the mcp-servers plan)

`src/shared/sidecar/officePackage.ts` hardcodes the legacy scope in four constants:

```ts
export const OFFICE_MCP_PACKAGE_NAME = '@mindstone-engineering/mcp-server-office';
export const OFFICE_MCP_PACKAGE_VERSION = '0.1.3';
export const OFFICE_MCP_PACKAGE_PATH_SEGMENTS = ['node_modules', '@mindstone-engineering', 'mcp-server-office'] as const;
export const OFFICE_MCP_SEED_TARBALL_FILENAME = `mindstone-engineering-mcp-server-office-${OFFICE_MCP_PACKAGE_VERSION}.tgz`;
```

If the catalog flip lands before the constants are updated, every Office user — including older users on stable builds who just pulled the new catalog as part of a Rebel auto-update — sees Office break: the sidecar can't locate the managed install at the path the constants expect.

Required Rebel work and merge ordering (do all of this BEFORE mcp-servers tags `office-v0.1.4`):

1. **Make the package locator tolerant of both scopes (defensive change, lands first).** Update `OFFICE_MCP_PACKAGE_PATH_SEGMENTS` to be an array of fallback candidates, and update callers in `officeSidecarManager.ts` to iterate. This single change is the load-bearing safety net: once landed, both old (`@mindstone-engineering/`) and new (`@mindstone/`) installs resolve, so neither merge order can leave Office broken. PR title: `fix(office): tolerate both legacy and new scope package paths during FOX-3319 migration`.
2. **Bump the version constant + seed target.** Update `OFFICE_MCP_PACKAGE_NAME = '@mindstone/mcp-server-office'` and `OFFICE_MCP_PACKAGE_VERSION = '0.1.4'`. Re-run `node scripts/build-managed-install-seeds.mjs` so `resources/managed-install-seeds/mindstone-mcp-server-office-0.1.4.tgz` exists (npm canonicalises `@mindstone/` to `mindstone-`, not `mindstone-engineering-`). This PR's CI fetches the new tarball from npm, so it can only land AFTER mcp-servers ships `office-v0.1.4`.
3. **Update snapshot tests in lockstep with step 2.** `scripts/check-office-package-version.ts`, `src/shared/__tests__/contributorMetadata.test.ts`, `src/main/services/__tests__/officeSidecarManager.test.ts`, `src/main/services/__tests__/managedMcpInstallService.test.ts`.

Merge sequence:

- **D-7 to D-1**: PR for step 1 (tolerant locator) opens, reviews, merges to `dev`. Office continues working on both `@mindstone-engineering/...@0.1.3` and any new install regardless of scope.
- **D-0**: mcp-servers tags `office-v0.1.4`. Auto-sync PR opens against Rebel `dev` but is held unmerged.
- **D-0**: PR for steps 2+3 opens immediately after `office-v0.1.4` is verified on npm, reviews, merges to `dev`.
- **D-0**: auto-sync PR is reviewed and merged.

The tolerant-locator PR from step 1 is what makes the merge order between auto-sync-PR and constants-PR non-load-bearing. Even if the auto-sync lands first by accident, Office still works because the locator falls back to the legacy scope.

### R7. Land the `upsertEntry` preservation patch (hard blocker B3 in the mcp-servers plan)

`scripts/import-rebel-oss-catalog-entry.ts` `buildCatalogEntry` unconditionally sets a fixed set of catalog fields, and `upsertEntry` then assigns `catalog.connectors[existingIndex] = newEntry`. The current preserve-list inside `upsertEntry` only covers `popular`, `hidden`, `featured`, `tools`, `bundledConfig`, and `mcpConfig.env`. Every other field present on the existing catalog entry but not set by the new entry gets dropped.

Local dry-run on 2026-05-15 against the 27 rebel-oss entries confirmed the dropped fields include `setupFields` (with `envVar`), `setupUrl`, `setupInstructions`, `setupUrlBehavior`, `setupUrlButtonLabel`, `callbackUrl`, `platforms`, `accountIdentity`, and `contributors`. Every one of those is consumed by either the Settings UI or runtime — see `bundledMcpManager.ts`, `setupFieldUtils.ts`, `ExpandedConnectionCard.tsx`, `mergeUpdateModePayload.ts`. After the first auto-sync, Settings UI breaks for ~20 connectors.

Required Rebel PR — adopt a generic "preserve everything not in the new entry" shallow merge plus a conditional `buildCatalogEntry`:

```ts
// buildCatalogEntry: only set fields the manifest carries.
// Replace the current unconditional object literal with conditional sets.
const entry: Record<string, unknown> = {
  provider: 'rebel-oss',
  mcpConfig: { transport: 'stdio', command: 'npx', args: [`-y`, `${npmPackage}@${version}`] },
};
for (const f of ['id','name','description','category','icon','maturity','verifiedSource','requiresSetup']) {
  if (manifest[f] !== undefined) entry[f] = manifest[f];
}
if (!('verified' in entry)) entry.verified = true;
if (manifest.accountIdentity !== undefined) entry.accountIdentity = manifest.accountIdentity;
if (manifest.contributors?.length) entry.contributors = manifest.contributors;
if (manifest.setupFields) {
  entry.setupFields = manifest.setupFields.map(f => ({
    id: f.key, label: f.label, type: f.type,
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
  }));
}

// upsertEntry: replace the per-field preserve list with a generic shallow merge.
// Existing fields fill any gaps the new entry doesn't override.
for (const [k, v] of Object.entries(existing)) {
  if (!(k in newEntry)) (newEntry as Record<string, unknown>)[k] = v;
}
// Preserve the env block inside mcpConfig (deep-merge, since mcpConfig itself is always overridden):
if (existing.mcpConfig?.env && newEntry.mcpConfig && !newEntry.mcpConfig.env) {
  newEntry.mcpConfig.env = existing.mcpConfig.env;
}
```

Regression test the PR must include: take any existing rebel-oss entry with a populated `setupFields[*].envVar`, `setupUrl`, `setupInstructions`, `callbackUrl`, `accountIdentity`, `platforms`, and `contributors`. Run the upsert with a minimal manifest. Assert every one of those fields appears unchanged on the output.

The mcp-servers side has already pre-validated this patch shape: the 26 phase-1 manifests in `connectors/*/catalog-entry.json` were written to the minimal shape and dry-run against this exact upsert logic. Every connector produces a clean three-field diff (`mcpConfig.args`, `verifiedSource`, optional cosmetic `maturity` default) — no setupFields/setupUrl/setupInstructions/callbackUrl/platforms/contributors regressions.

Land this PR alongside R5 step 1 (Office tolerant locator) during the D-7 to D-1 window so all defensive Rebel-side fixes are in place before tags fire. Verify with the synthetic-dispatch smoke test (R1) after the patch lands — the smoke test for `fathom` should produce a PR whose diff touches only `mcpConfig.args` and (cosmetically) `verifiedSource` + `maturity`.

### R6. Update `bundledInboxBridge.ts` Salesforce fallback (low priority, opportunistic)

`src/main/services/bundledInboxBridge.ts:2023` has a hardcoded legacy-scope fallback:

```ts
args: existing?.args ?? ['-y', '@mindstone-engineering/mcp-server-salesforce'],
```

This branch only fires for net-new users with no prior config. During the 90-day deprecation window, the fallback continues to resolve fine (legacy scope still serves). After lockdown (day 90) the package still installs but with a deprecation warning. Net regression risk for older users: zero. Update opportunistically in any Rebel PR touching Salesforce code — does not gate any sub-wave.

---

## During the wave

### W1. Watch every sub-wave for catalog-sync PR creation

Subscribe to Rebel's `dev` branch and to the `automated`/`mcp-catalog` label combination. Each successful mcp-servers tag publish should produce exactly one new PR within 5 minutes:

- Title: `chore(catalog): sync <connector> v<X.Y.Z> from rebel-oss`
- Branch: `catalog-sync/<connector>`
- Base: `dev`
- Diff: a single-line change in `resources/connector-catalog.json` flipping `mcpConfig.args[-1]` from `@mindstone-engineering/mcp-server-<connector>@<old>` to `@mindstone/mcp-server-<connector>@<new>`

Expected per sub-wave (auto-sync PRs opened against `dev`):
- Sub-wave A: 4 PRs (`fathom`, `humaans`, `pandadoc`, `talentlms`)
- Sub-wave B: 16 PRs (mid-risk; everything not in A or C, minus slack)
- Sub-wave C: 3 PRs (`salesforce`, `office`, `email-imap` — `bundled-custom-email` surface only)
- Slack: 1 PR (net-new rebel-oss entry, see W4)
- Apple-shortcuts catch-up: 1 PR (phase 3.0 synthetic dispatch in the mcp-servers plan)

Subtotal auto-sync: 25 PRs.

Additional non-auto-sync PRs opened by Rebel maintainers:
- Email-imap follow-up M1: 1 PR for `bundled-icloud-mail` + `bundled-yahoo-mail` (W4-email-imap)
- Office constants: 2 PRs (R5 step 1 tolerant locator, then R5 step 2+3 version bump)

Total expected PRs against Rebel `dev` during the wave: ~28.

### W2. Review checklist per PR (~2 min each)

For each `catalog-sync/<connector>` PR, before approving:

- [ ] Diff is exactly a `mcpConfig.args[-1]` update, with no other field touched (except `version`, `verified`, `verifiedSource`, `maturity` if drift exists)
- [ ] `bundledConfig` is unchanged (especially the 25 of 27 entries that carry it; see R4)
- [ ] `tools` array is unchanged (the import script preserves it via `if (existing.tools && !newEntry.tools)`)
- [ ] `popular`, `hidden`, `featured` curation fields are unchanged
- [ ] The new `package@version` string in `args[-1]` matches the version mcp-servers actually shipped (cross-reference `npm view`)
- [ ] For email-imap: only `bundled-custom-email` is updated by auto-sync; the 2 follow-up surfaces (`bundled-icloud-mail`, `bundled-yahoo-mail`) are handled by W4-email-imap and must NOT be in this auto-sync diff
- [ ] For office: R5 step 1 (tolerant locator) has already landed on `dev`; if not, request changes and link to R5

If any of the above fails, request changes — do NOT merge a malformed catalog. The Rebel `connectorCatalog.test.ts` suite will fail the PR CI in most cases, but the import-pipeline guard runs at workflow time, not PR time, so a malformed catalog can in principle reach PR-state.

### W3. Merge cadence

Approve and merge each PR within 24h of opening. Letting them stack creates conflict risk if two PRs target adjacent fields. Rebase strategy: `peter-evans/create-pull-request` auto-rebases on conflict; no manual rebase needed unless a custom curation change lands on `dev` in between.

### W4. Slack (special — net-new entry, not an upsert)

Slack's `catalog-entry.json` id is `bundled-slack` post-mcp-servers-phase-1. The existing `bundled-slack` entry in the catalog has `provider: bundled` (in-process). The auto-sync workflow will:

- Find the existing `bundled-slack` entry
- Replace it with a `provider: rebel-oss` entry pointing at `npx -y @mindstone/mcp-server-slack@0.1.1`
- Preserve the existing `bundledConfig`, `tools`, and curation

This is the desired outcome (Slack moves from in-process to managed-npx, modeled on the hubspot cutover). The Rebel maintainer reviewing this PR must additionally confirm:

- The Rebel main process still starts the in-process Slack server during the deprecation window (consumers on older builds depend on it); the catalog flip alone does not delete the bundled server source from Rebel. A follow-up PR can retire the bundled source after the deprecation window.
- Slack's setupFields render correctly in the Settings UI (verify on a fresh local Rebel build before merging).

### W4-email-imap. Email IMAP (special — 1 dispatch, 3 catalog entries)

Hard blocker B2 in the mcp-servers sibling plan: the `email-imap` connector ships one npm package but the Rebel catalog represents three surfaces (`bundled-custom-email`, `bundled-icloud-mail`, `bundled-yahoo-mail`), all pinned to the same legacy package. When mcp-servers tags `email-imap-v0.2.3` (sub-wave C), the dispatch triggers the import script ONCE with id `bundled-custom-email` (per phase 1.1 spec on the mcp-servers side) — and the script updates exactly that one entry.

After the auto-sync PR for `bundled-custom-email` merges to `dev`, run this manual M1 follow-up immediately:

```sh
cd /path/to/MindstoneRebel-1
git checkout dev && git pull
git checkout -b catalog-sync/email-imap-extra-surfaces
python3 - <<'PY'
import json
path = 'resources/connector-catalog.json'
with open(path) as f: d = json.load(f)
new_pkg = '@mindstone/mcp-server-email-imap@0.2.3'
touched = []
for c in d['connectors']:
    if c['id'] in ('bundled-icloud-mail', 'bundled-yahoo-mail'):
        c['mcpConfig']['args'] = ['-y', new_pkg]
        touched.append(c['id'])
print('updated:', touched)
with open(path, 'w') as f: json.dump(d, f, indent=2); f.write('\n')
PY
git diff resources/connector-catalog.json   # confirm exactly 2 lines change, both args[-1]
npm test -- connectorCatalog                # invariant suite must pass
git add resources/connector-catalog.json
git commit -m "fix(catalog): Sync iCloud Mail + Yahoo Mail to @mindstone/mcp-server-email-imap@0.2.3. Companion to the auto-sync PR for bundled-custom-email; auto-sync only updates one catalog entry per dispatch, and email-imap maps 1:3."
gh pr create --base dev --title "fix(catalog): email-imap follow-up — update iCloud + Yahoo surfaces"
```

Merge this PR within the same Rebel deploy window as the auto-sync PR so all three surfaces flip together. If they land in different deploys, users on the in-between build see one surface on the new package and two on the legacy package; both work but the version-skew is visible in Rebel's about-pages.

---

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| No `catalog-sync/<connector>` PR within 10 min of publish | `CATALOG_SYNC_TOKEN` missing or revoked in mcp-servers | mcp-servers G2 pre-flight failed; check `gh run view --log` on the publish.yml run for the dispatch step |
| Sync workflow runs but fails at `Verify catalog-entry.json exists` | mcp-servers `catalog-entry.json` not in the published SHA | mcp-servers phase 1 didn't merge before the tag; fix manifest, re-tag (or fall back to the manual flip in M1 below) |
| Sync workflow runs but fails at the import script | `validateBundledConfigInvariant` rejected the entry | The mcp-servers manifest has `requiresSetup: true` but `setupFields` is empty/missing; fix mcp-servers manifest; re-run sync workflow with `gh workflow run rebel-oss-catalog-sync.yml -f` and the original payload |
| PR opens but the diff replaces `bundledConfig` with `undefined` | Import script regression OR the existing entry's `bundledConfig` is malformed | Block merge; file Rebel bug; do M1 manual flip |
| PR opens but base is wrong (not `dev`) | Default branch on Rebel changed | Update `rebel-oss-catalog-sync.yml` base reference; do M1 for affected connectors in the meantime |
| PR opens with double-entry (existing `bundled-<connector>` plus new `<other-id>`) | mcp-servers `catalog-entry.json` id does not match `bundled-<connector>` | mcp-servers phase 1.2 didn't fix that connector's id; do M1 for this connector and back-fix phase 1.2 |

### M1. Manual flip fallback (modeled on hubspot commit `92e9a6506`)

If auto-sync diverges for any single connector, fall back to manual:

```sh
cd /Users/harry/development/desktop/MindstoneRebel-1
git checkout dev
git pull
git checkout -b catalog-sync/<connector>-manual
python3 - <<'PY'
import json
path = 'resources/connector-catalog.json'
with open(path) as f: d = json.load(f)
target = 'bundled-<connector>'
new_pkg = '@mindstone/mcp-server-<connector>@<X.Y.Z>'
for c in d['connectors']:
    if c['id'] == target:
        c['provider'] = 'rebel-oss'
        c['mcpConfig']['args'] = ['-y', new_pkg]
        break
else:
    raise SystemExit(f'no entry {target}')
with open(path, 'w') as f: json.dump(d, f, indent=2); f.write('\n')
PY
git diff resources/connector-catalog.json
npm test -- connectorCatalog   # invariant suite
git add resources/connector-catalog.json
git commit -m "fix(mcp): Manually flip <connector> @mindstone-engineering -> @mindstone (FOX-3319). Auto-sync diverged: <reason>. Modeled on 0cfce86db (hubspot cutover)."
gh pr create --base dev --title "fix(mcp): Manually flip <connector> to @mindstone scope"
```

---

## Post-wave

### P1. Audit catalog state after every sub-wave is merged

```sh
cd /Users/harry/development/desktop/MindstoneRebel-1
python3 -c "
import json
with open('resources/connector-catalog.json') as f: d = json.load(f)
for c in d['connectors']:
    if c.get('provider') == 'rebel-oss':
        pkg = (c.get('mcpConfig',{}).get('args') or [None])[-1]
        marker = '✓' if pkg and pkg.startswith('@mindstone/') else '✗'
        print(f\"  {marker} {c['id']:32s} {pkg}\")
"
```

Expected post-wave: every `rebel-oss` entry has `@mindstone/...` (not `@mindstone-engineering/...`). The exception is any connector with a `bundledConfig` that explicitly pins the legacy package name — those should be tracked separately as known-stragglers.

### P2. Telemetry watch (Rebel runtime)

For 7 days after the final sub-wave, monitor Rebel's managed-MCP install telemetry for:

- `*.quarantine.quarantined` events — indicates a connector failed to install or run repeatedly
- `package_install_failed` with the new `@mindstone/...` package name
- Connector-specific telemetry rates (e.g. `hubspot.refresh_failed`) for regressions vs baseline

If any of these spike, treat as a regression for the offending connector and trigger `EMERGENCY_REVOKE.md` on the mcp-servers side.

### P3. After the 90-day window (`MIGRATION.md` timeline)

The legacy scope's publish rights get revoked on the npm side. At that point Rebel can:

- Drop `@mindstone-engineering/` from any allowlist (the legacy-prefix entries flagged in `src/main/services/managedMcpInstallService.ts` etc.)
- Remove backwards-compat aliases (`MINDSTONE_REBEL_BRIDGE_STATE` etc.) from connector source — but coordinate with mcp-servers because that's a mcp-servers-side change too
- Retire the bundled (in-process) source for Slack once consumers have rolled forward off old Rebel builds

This is a separate plan; flag it for Q3 2026.

---

## Communication

### Notification points

- **Before phase 0**: post in the Rebel maintainer channel announcing the wave start date, named maintainer, and the expected ~24 PRs incoming.
- **After each sub-wave**: post a short summary (`N connectors landed: <list>. Verified <X> attestations. M1 fallbacks needed: <list or none>`).
- **End of wave**: post a final summary with the P1 audit output and the named on-call maintainer for the 7-day window.
- **End of 7-day window**: post all-clear OR open a follow-up plan for any straggler.

### Where the audit trail lives

- Per-publish: GitHub Actions run logs in mcp-servers (publish workflow) and Rebel (catalog-sync workflow), retained 90 days per repo default.
- Per-PR: the `catalog-sync/<connector>` PR on Rebel's `dev` branch (reviewer name, merge time, diff).
- Per-version: `npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json | jq .dist.attestations` is the canonical record.
- Per-incident (if any): a postmortem in `MindstoneRebel/docs/postmortems/`, linked from this plan.

---

## Risks specific to the Rebel side

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 24 PRs swamp the maintainer review queue | Medium | Days of merge lag, catalog drift between repos | Phase 3 sub-waves space the PRs over 4+ days |
| A reviewer skim-approves a malformed diff | Low | Bad catalog ships to `dev` build | W2 checklist; CI runs `connectorCatalog.test.ts` on every PR |
| Hubspot-style manual override gets re-applied on top of an auto-sync PR | Low | Merge conflict, possible regression | M1 only when auto-sync has failed; do not run both paths for the same connector |
| Concurrent agent commits to `connector-catalog.json` during the wave | Medium (Rebel is active) | Merge conflicts on `catalog-sync/*` branches | `peter-evans/create-pull-request` auto-rebases; if it fails, manually rebase or close-and-reopen |
| `validateBundledConfigInvariant` rejects a connector that ships fine in mcp-servers | Low | Sync stalls for that connector | mcp-servers phase 1.1 ensures manifest carries the invariant-required fields; M1 is the fallback |

---

## Cross-references

- [mcp-servers sibling plan](./260515_finalise_mindstone_scope_publish.md) — the per-publish execution path this document responds to
- [`MIGRATION.md`](../../MIGRATION.md) — the canonical migration runbook
- `MindstoneRebel/.github/workflows/rebel-oss-catalog-sync.yml` — the listener
- `MindstoneRebel/scripts/import-rebel-oss-catalog-entry.ts` — the upsert script (see `validateCatalogImport.ts` for the bundledConfig guard)
- `MindstoneRebel/docs/postmortems/260424_oss_catalog_sync_automation_never_worked_postmortem.md` — historical context on why this handoff was needed
- `MindstoneRebel/docs/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md` — the `bundledConfig` regression that motivated the invariant guard
- Rebel commit `92e9a6506` — the manual hubspot cutover, template for M1 manual flips
- Rebel commit `0cfce86db` — the canonical hubspot scope-flip (`@mindstone-engineering` → `@mindstone`) used as the diff shape reference for W2
