# Finalise `@mindstone/` scope publish — staged execution plan

**Date**: 2026-05-15
**Owner**: TBD (named maintainer for the 7-day on-call window, per `docs/PUBLISH_APPROVAL_PROCESS.md`)
**Scope**: This repo only. The Rebel-side coordination is in the sibling plan `260515_rebel_catalog_handoff.md` and must be read in tandem.

---

## Goal

Complete the FOX-3319 npm-scope migration by shipping every connector under the new `@mindstone/` scope at the version already landed on `main`, then close the legacy `@mindstone-engineering/` line with a dual-publish + deprecation sweep, leaving the deprecation-window clock running. This document sequences the work that `MIGRATION.md` describes per-package but does not order across the 24-package wave.

Out of scope: behaviour changes, version bumps, security work. Every connector listed below already has a tagged-version-ready `package.json` on `main` and a matching `CHANGELOG.md` section.

---

## Current state (verified 2026-05-15)

| Status | Count | Detail |
|---|---|---|
| Published on `@mindstone/` at the local version | 2 | `hubspot@0.1.2`, `apple-shortcuts@0.1.2` |
| Published on `@mindstone-engineering/` only (need OIDC tag-publish on new scope) | 23 | every other connector except slack |
| Never published on either scope (needs bootstrap publish first) | 1 | `slack@0.1.1` |
| Working tree | clean | `main`, last commit `fa29c2e chore(release): hubspot v0.1.2` |
| CHANGELOG entries for current local version | 26/26 | every connector has a section matching `package.json#version` |

Full table of local versions vs the two scopes is at the foot of this document.

---

## Hard blockers (must be resolved before phase 1, full stop)

Two connectors break the per-connector independence assumption every other connector enjoys. They need explicit Rebel-side preparation before their catalog flip can ship, and that work must be tracked in this plan because skipping it ships a regression to existing users.

### B1. Office requires a Rebel source-code change paired with the catalog flip

`mindstone/MindstoneRebel/src/shared/sidecar/officePackage.ts` hardcodes the legacy scope in four constants:

```ts
export const OFFICE_MCP_PACKAGE_NAME = '@mindstone-engineering/mcp-server-office';
export const OFFICE_MCP_PACKAGE_VERSION = '0.1.3';
export const OFFICE_MCP_PACKAGE_PATH_SEGMENTS = ['node_modules', '@mindstone-engineering', 'mcp-server-office'] as const;
export const OFFICE_MCP_SEED_TARBALL_FILENAME = `mindstone-engineering-mcp-server-office-${OFFICE_MCP_PACKAGE_VERSION}.tgz`;
```

These constants drive: (1) the managed-install fast path (seed tarball pre-shipped in `resources/managed-install-seeds/`), (2) the post-install package locator in `node_modules`, (3) version checks in `scripts/check-office-package-version.ts`. Flipping only the catalog entry (which is what auto-sync does) leaves the constants dangling — first user who picks up the new catalog entry installs `@mindstone/mcp-server-office@0.1.4` to `node_modules/@mindstone/...`, then Office sidecar fails to locate it because the path segments expect `@mindstone-engineering`.

Required sequence (full detail in the sibling plan's R5):

1. **Rebel side, D-7 to D-1**: land a Rebel PR that makes the Office package-path locator tolerant of BOTH scopes. This is the load-bearing safety net — after this lands, neither merge order between catalog-flip and version-constants can leave Office broken for any user. `OFFICE_MCP_PACKAGE_PATH_SEGMENTS` becomes a fallback array; `officeSidecarManager.ts` callers iterate.
2. **mcp-servers side, D-0**: tag `office-v0.1.4` (sub-wave C). OIDC publish runs. Auto-sync dispatch fires; Rebel auto-sync PR opens, holds unmerged.
3. **Rebel side, D-0**: open the version-bump PR that updates `OFFICE_MCP_PACKAGE_NAME`, `OFFICE_MCP_PACKAGE_VERSION`, and snapshots. Its CI fetches `@mindstone/mcp-server-office@0.1.4` from npm (now live), rebuilds the seed tarball. Merge to `dev`.
4. **Rebel side, D-0**: review and merge the auto-sync PR.

The tolerant-locator step is what removes the timing bomb: it lets the two D-0 PRs land in either order without leaving Office broken in any user's running app. Without step 1, the auto-sync PR can only safely merge in the same deploy as the version-bump PR — a tight coupling that historical experience shows is hard to enforce.

### B3. Rebel's `upsertEntry` overwrites existing entry fields the manifest doesn't carry — would drop `setupFields.envVar` for 20+ connectors

Verified 2026-05-15: `scripts/import-rebel-oss-catalog-entry.ts` builds the new entry from manifest fields only and then assigns `catalog.connectors[existingIndex] = newEntry`. The preserve-list in `upsertEntry` covers `popular`, `hidden`, `featured`, `tools`, `bundledConfig`, and `mcpConfig.env`. It does NOT cover `setupFields` or `accountIdentity`.

Consequence: when the auto-sync runs against an existing `bundled-<connector>` entry whose `setupFields` carry `envVar` (true for 20+ connectors today: fathom, pandadoc, mixmax, gamma, napkin, elevenlabs, retell-ai, kling, runway, nano-banana, browser-automation, humaans, workday, quickbooks, servicenow, talentlms, google-analytics, freshdesk, custom-email + the iCloud/Yahoo surfaces, etc.), the new entry's `setupFields` lacks `envVar`. `envVar` is load-bearing in:

- `src/main/services/bundledMcpManager.ts` — connector spawn env population
- `src/shared/utils/setupFieldUtils.ts` — central env utility
- `src/renderer/features/settings/components/ExpandedConnectionCard.tsx` — Settings UI read/write
- `src/main/services/mergeUpdateModePayload.ts` — runtime payload assembly

After the first auto-sync for an envVar-using connector: the Settings UI cannot read or write the user's API key, and the connector spawn env block stays empty — connector fails on next start. The 260424 Rebel postmortem noted the catalog sync was historically broken, so this latent bug has never surfaced in production yet.

A 2026-05-15 dry-run revealed that `setupFields.envVar` is only one of many fields the current script silently drops. Other affected (load-bearing) fields: `setupUrl`, `setupInstructions`, `setupUrlBehavior`, `setupUrlButtonLabel`, `callbackUrl`, `platforms`, `contributors`, `accountIdentity`. Each is used by the Rebel Settings UI or runtime. The Settings UI for almost every connector would break on first auto-sync today.

**Adopted resolution — Option A v3**: a slightly larger Rebel-side patch (~15 LOC) implementing a generic "preserve all unspecified fields" shallow merge, plus making `buildCatalogEntry` conditional. The fix is structural: instead of enumerating preserved fields one-by-one (current upsertEntry preserves popular/hidden/featured/tools/bundledConfig/mcpConfig.env), it preserves ANY existing field the manifest doesn't explicitly override.

```ts
// buildCatalogEntry — only set fields the manifest carries.
// Was:
//   const entry: Record<string, unknown> = {
//     id, name, description, category, provider: 'rebel-oss',
//     mcpConfig: {...},
//     icon, verified: true, verifiedSource, requiresSetup, maturity,
//     accountIdentity: manifest.accountIdentity,
//   };
// Now:
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

// upsertEntry — generic preserve-all-unspecified shallow merge.
// Replace the per-field if-statements with:
for (const [k, v] of Object.entries(existing)) {
  if (!(k in newEntry)) newEntry[k] = v;
}
// Plus the existing deep preserve for mcpConfig.env:
if (existing.mcpConfig?.env && newEntry.mcpConfig && !newEntry.mcpConfig.env) {
  newEntry.mcpConfig.env = existing.mcpConfig.env;
}
```

The regression test for this PR upserts an existing entry that carries `setupFields[*].envVar`, `setupUrl`, `setupInstructions`, `accountIdentity`, `callbackUrl`, `platforms`, and `contributors`, against a minimal-shape manifest, and asserts every one of those fields survives unchanged on the output.

mcp-servers-side consequence — phase 1 manifests carry ONLY: `id`, `name`, `description`, `category`, `icon`, `maturity`, `verifiedSource`, `requiresSetup`. Everything else stays in the Rebel catalog as canonical and survives upsert.

Local dry-run on 2026-05-15 against the 26 current Rebel catalog entries confirms: every connector produces exactly the intended diff (mcpConfig.args scope flip + verifiedSource pointing at the OSS repo + cosmetic maturity default for entries with no prior maturity field). No setupFields, setupUrl, setupInstructions, callbackUrl, platforms, accountIdentity, or contributors changes.

This blocks phase 3 (any tag publish would fire auto-sync). It does NOT block phase 1 of mcp-servers prep — the manifests we write in 1.1/1.2 are correctly minimal regardless.

### B2. `email-imap` connector maps to 3 catalog entries — auto-sync only updates 1

The `email-imap` connector ships one npm package, but the Rebel catalog represents three user-facing surfaces from it:

- `bundled-custom-email` — generic IMAP, requires user-supplied server
- `bundled-icloud-mail` — preset for iCloud's IMAP server
- `bundled-yahoo-mail` — preset for Yahoo's IMAP server

All three pin `@mindstone-engineering/mcp-server-email-imap@0.2.2` in their `mcpConfig.args`. The auto-sync import script reads `catalog-entry.json` and upserts ONE entry keyed on the manifest's `id`. So an `email-imap` tag publish fires one dispatch → one catalog entry updates → the other two remain pinned at the legacy package version.

Three options:

- **Option E1 (recommended, simplest)**: phase 1.1 ships `connectors/email-imap/catalog-entry.json` with `id: "bundled-custom-email"`. Auto-sync updates that one. The Rebel handoff plan W4 includes an explicit manual M1 flip for `bundled-icloud-mail` and `bundled-yahoo-mail` to keep all three in sync.
- **Option E2 (Rebel-side fix)**: extend `scripts/import-rebel-oss-catalog-entry.ts` to accept an `--also-update <id> [<id>...]` flag that mirrors the package@version update across additional catalog ids. This is the right long-term shape but adds 1-2 days to Rebel work; not blocking this wave.
- **Option E3 (mcp-servers-side workaround)**: phase 1.1 ships three `catalog-entry-<surface>.json` files; the workflow is extended to loop. More moving parts; pushes complexity to mcp-servers.

This plan adopts E1. The two manual flips are documented in the sibling plan under W4-email-imap.

---

## Pre-flight gate (everything below MUST be true before phase 2 starts)

Each item is a discrete check. None of them require code changes; they are environmental and one is repo-local.

### G1. `npm-publish` GitHub Actions environment exists, with required reviewer

The publish workflow declares `environment: npm-publish`. Without the environment object the OIDC token mint runs without an approval gate. The fact that `hubspot@0.1.2` and `apple-shortcuts@0.1.2` published successfully implies the environment exists — verify in repo Settings → Environments → `npm-publish` that:

- At least one required reviewer is configured, and that reviewer is NOT the author of any pending release commit
- `Deployment branches and tags` is restricted to `*-v*` tags (so PRs cannot synthesise environment access)

### G2. `CATALOG_SYNC_TOKEN` repo secret is set and scoped to `mindstone/MindstoneRebel` only

The `dispatch-catalog-sync` job in `.github/workflows/publish.yml` fires a `repository_dispatch` to Rebel. The Rebel-side 260424 postmortem (`docs/postmortems/260424_oss_catalog_sync_automation_never_worked_postmortem.md` in MindstoneRebel) documents that this secret was historically missing — `hubspot` and `apple-shortcuts` shipped without their catalog sync firing.

Verify before phase 2:

```sh
gh secret list --repo mindstone/mcp-servers | grep CATALOG_SYNC_TOKEN
```

The token must be a fine-grained PAT or GitHub App install token with `repository_dispatch: write` on `mindstone/MindstoneRebel` ONLY. A broadly-scoped token here defeats the structural mitigation that the dispatch runner has no other capability.

If the secret is missing, do NOT start phase 2 — the manual Rebel handoff in the sibling plan becomes the load-bearing path and Rebel maintainers must be on standby for every publish.

### G3. CODEOWNERS team slug `@mindstone/oss-maintainers` resolves

`.github/CODEOWNERS` still has the placeholder. If the GitHub team does not exist, every PR will silently bypass the codeowner-review requirement (GitHub treats unresolvable owners as "no owner"). Confirm with:

```sh
gh api orgs/mindstone/teams/oss-maintainers | jq .name
```

If the team does not exist, either create it with the publish-approval maintainer set, or edit CODEOWNERS to name explicit GitHub users before phase 1 lands.

### G4. Trusted-publisher bindings configured on the 23 new-scope packages that already exist

For `hubspot` and `apple-shortcuts` the binding clearly works (both publishes landed via OIDC). For the other 21 connectors whose `@mindstone/` package has never published, the binding cannot be configured on npm until the package exists. Two paths:

- **Path A (recommended)**: bootstrap-publish a `0.0.0-bootstrap` placeholder locally with `--access public`, configure trusted-publisher binding on npm, then immediately deprecate the bootstrap version with `npm deprecate '<pkg>@0.0.0-bootstrap' 'placeholder version, do not install'`. Cost: ~30 min per package, no behaviour risk, follows MIGRATION.md step 2 verbatim for two of them anyway (slack, google-analytics).
- **Path B**: confirm whether npm now honours an org-level Trusted Publisher policy on the `@mindstone` scope that allows first-publishes via OIDC. If it does, no bootstrap is needed for the 21. If it does not, path A is required.

Action: open `https://www.npmjs.com/settings/mindstone/access` and check for a scope-level trusted publisher config. If unsure, default to path A.

### G5. Slack `catalog-entry.json` schema matches the import script's contract

Phase 1 already fixes this, but call out the gap explicitly here so the work is visible: `connectors/slack/catalog-entry.json` currently has `verifiedSource: true` (boolean) and `id: "slack"`. The import script in Rebel (`scripts/import-rebel-oss-catalog-entry.ts`) requires `verifiedSource` to be a truthy string and uses the manifest `id` verbatim — feeding `"slack"` would create a parallel catalog entry next to the existing `bundled-slack`. Same shape issue exists in `outreach`, `salesforce`. See phase 1.

---

## Phase 1 — Repo-local prep (no publish, no tag)

These are file changes to this repo that close the catalog-sync gap before any tag fires the Rebel dispatch. They land in one PR, reviewed under the standard CODEOWNERS gate.

### 1.1. Backfill `catalog-entry.json` for the 20 connectors that lack one

The 6 connectors that already have a manifest are `outreach`, `browser-automation`, `retell-ai`, `slack`, `salesforce`, `zendesk` — those are covered by phase 1.2. The 20 connectors missing a manifest entirely are:

`apple-shortcuts`, `elevenlabs`, `email-imap`, `fathom`, `freshdesk`, `gamma`, `google-analytics`, `hubspot`, `humaans`, `kling`, `mixmax`, `nano-banana`, `napkin`, `office`, `pandadoc`, `quickbooks`, `runway`, `servicenow`, `talentlms`, `workday`.

Each new `catalog-entry.json` must:

- Use `id: "bundled-<connector>"` to match the existing Rebel catalog entry's id. The import script's upsert path is keyed on `id`. If the manifest's `id` does not match any existing entry, the script appends a parallel entry, leaving the original `bundled-*` row untouched at the legacy package version. This is exactly the failure mode the manual hubspot flip in Rebel commit `92e9a6506` worked around. Matching `id` is what makes the auto-sync update-in-place instead of duplicating.
- Use `verifiedSource: "https://github.com/mindstone/mcp-servers"` as a string (not boolean). The import script validates with `if (!manifest[field])`, which a boolean `true` would pass, but it then writes the boolean verbatim into the catalog — schema drift downstream.
- Carry the full `setupFields` array using the manifest's `key` shape (the script maps `key` → catalog's `id` automatically).
- Match `requiresSetup` and `setupFields` length to the existing `bundled-<connector>` entry verbatim — flipping `requiresSetup` would change Rebel's setup-UI rendering, and a `requiresSetup: true` + empty-setupFields combination trips `validateBundledConfigInvariant` even when the existing `bundledConfig` is fine. Per the 2026-05-15 catalog audit:
  - `apple-shortcuts`: `requiresSetup: false`, empty `setupFields` (skip-the-invariant path)
  - `hubspot`: omit `requiresSetup` entirely (catalog has `requiresSetup: undefined`)
  - `office`: `requiresSetup: false`, empty `setupFields`
  - `email-imap`: match `bundled-custom-email`'s 5 setupFields (only this one of the three surfaces is sync-target per E1 above)
  - all other 17 in the backfill list: `requiresSetup: true`, full setupFields per the existing entry

The five with `bundledConfig.authType + serverName + ...` already configured in the Rebel catalog (`bundled-hubspot`, `bundled-zendesk`, `bundled-google-analytics`, `bundled-office`, `bundled-slack`) inherit their `bundledConfig` from the existing entry via the import script's preserve-on-upsert path — no new field needed here. `validateBundledConfigInvariant` in Rebel's import-pipeline guard will refuse the write if `bundledConfig` ends up missing for a `requiresSetup + setupFields` entry, so a misconfigured manifest fails loudly in the Rebel CI before any catalog state ships.

### 1.2. Fix the 6 broken-id `catalog-entry.json` files already in the repo

| connector | current id | required id | current verifiedSource | required |
|---|---|---|---|---|
| outreach | `outreach` | `bundled-outreach` | `true` | `"https://github.com/mindstone/mcp-servers"` |
| salesforce | `salesforce` | `bundled-salesforce` | `true` | `"https://github.com/mindstone/mcp-servers"` |
| slack | `slack` | `bundled-slack` | `true` | `"https://github.com/mindstone/mcp-servers"` |
| zendesk | `rebel-oss-zendesk` | `bundled-zendesk` | already string | (no change) |
| retell-ai | `rebel-oss-retell-ai` | `bundled-retell-ai` | already string | (no change) |
| browser-automation | `rebel-oss-browser-automation` | `bundled-browser-automation` | already string | (no change) |

Sanity test for the PR: run Rebel's `scripts/import-rebel-oss-catalog-entry.ts` locally against a copy of `resources/connector-catalog.json` for each updated manifest, with the package + version that phase 2 will publish, and confirm the diff is in-place (`mcpConfig.args[-1]` flips to the new scope, everything else unchanged). The Rebel-side plan covers the dry-run command.

### 1.3. Add a per-connector publish tracking issue template

Optional but recommended. `docs/PUBLISH_APPROVAL_PROCESS.md` requires a tracking issue per release; cutting 24 of them by hand is brittle. A `.github/ISSUE_TEMPLATE/publish-approval.yml` with the standard checklist saves the named maintainer ~15 min per connector and makes the audit log uniform.

### 1.4. PR review and merge

CODEOWNERS gate applies. Merge to `main` before phase 2 starts. No tags yet.

---

## Phase 2 — Bootstrap publishes (one-time, local, 2FA)

Only required for the connectors whose `@mindstone/` package does not exist on npm. That is: every connector except `hubspot` and `apple-shortcuts`. Per G4 above, default to path A unless an org-level scope policy on `@mindstone` makes path B viable.

For each of the 24 connectors:

```sh
cd connectors/<connector>
# Authenticate the publishing user (2FA prompt expected)
npm whoami            # confirm logged in as a @mindstone-scope publisher
# Create the package + a placeholder version
npm pack --ignore-scripts
# Publish the placeholder
npm publish ./*.tgz --access public --tag bootstrap
# Deprecate the placeholder immediately
npm deprecate "@mindstone/mcp-server-<connector>@<placeholder-version>" \
  "Bootstrap placeholder, do not install. Real release at <X.Y.Z>."
```

The placeholder must be a SemVer prerelease (e.g. `0.0.0-bootstrap.0`) AND published with `--tag bootstrap` rather than `--tag latest`. Two independent guards prevent the placeholder from being resolved as `latest` by an unpinned `npm install`:

1. `--tag bootstrap` skips setting the `latest` dist-tag, so the package has no `latest` until the real phase-3 publish lands.
2. Even if `latest` is unset, npm's default resolution for unpinned installs picks the highest non-prerelease version; the prerelease suffix excludes the placeholder from that calculation.

The `npm deprecate` command immediately after publish is belt-and-braces — a `latest` regression at npm's side (or a manual `npm dist-tag add` mistake) would still surface a clear deprecation warning to any consumer who pulled the placeholder.

After each bootstrap:

```sh
# On https://www.npmjs.com/package/@mindstone/mcp-server-<connector>/access
# → Trusted Publisher → Configure:
#   Repository: mindstone/mcp-servers
#   Workflow filename: publish.yml
#   Environment name: npm-publish
```

24 bootstraps × ~5 min each = ~2 hours of focused work. This is the longest-running serial step in the plan. It cannot be parallelised across humans (npm 2FA is per-account).

**Exit criterion**: `npm view @mindstone/mcp-server-<each connector> versions` returns at least one version, and each package's `/access` page shows the trusted-publisher binding green.

---

## Phase 3 — OIDC release wave (24 tag pushes)

**Dependency:** for each connector tagged in this phase, phase 1 must be merged AND phase 2 bootstrap (if applicable) must be complete for that specific connector. Cross-sub-wave parallelism is fine; per-connector ordering is strict.

Sequenced in three sub-waves to control the blast radius of any one bad release. The 7-day `min-release-age` cool-down enforced by `.npmrc` means a Rebel consumer with `min-release-age=7` will not pick up these versions for 7 days regardless — but the publish-side gate is structural, not consumer-side, so we still want a graduated rollout.

### 3.0. Catch-up: apple-shortcuts already published, catalog not yet flipped

`apple-shortcuts@0.1.2` shipped under `@mindstone/` on 2026-05-14, but the Rebel catalog still pins `@mindstone-engineering/mcp-server-apple-shortcuts@0.1.1` (per Rebel `resources/connector-catalog.json` audit on 2026-05-15). Phase 3 for apple-shortcuts is not a re-publish — it is a one-off synthetic dispatch to Rebel's sync workflow plus a Rebel-side review, executed after phase 1 lands:

```sh
gh api repos/mindstone/MindstoneRebel/dispatches \
  -f event_type=connector-published \
  -f client_payload[connector]=apple-shortcuts \
  -f client_payload[package]=@mindstone/mcp-server-apple-shortcuts \
  -f client_payload[version]=0.1.2 \
  -f client_payload[sha]=$(git rev-parse origin/main)
```

The sibling Rebel plan covers the PR review for the resulting auto-sync. If the sync workflow refuses (typically because catalog-entry.json wasn't in the dispatched SHA), fall back to the M1 manual flip — modeled on Rebel commit `0cfce86db` (the hubspot scope flip).

Apple-shortcuts skips phase 2 (already published on new scope) and phase 4 step 1 ("dual-publish") only — phase 4 step 2 (`npm deprecate` legacy versions) still applies and must be run.

### 3.1. Sub-wave A — 4 low-risk connectors (day 1)

Pick connectors that:
- Are not on the critical OAuth path
- Have the smallest user-facing surface area
- Already exist on the legacy scope (so the dual-publish in phase 4 is a no-op-risk sanity check)

Candidate list (pending owner confirmation): `fathom`, `humaans`, `pandadoc`, `talentlms`.

For each:

```sh
git checkout main
git pull
git tag <connector>-v<X.Y.Z>
git push origin <connector>-v<X.Y.Z>
```

Pushing the tag triggers `.github/workflows/publish.yml`. The publish job pauses on the `npm-publish` environment approval gate. The named maintainer approves; OIDC publish runs.

After each publish:

```sh
npm view @mindstone/mcp-server-<connector>@<X.Y.Z> --json \
  | jq '{version, dist:{integrity:.dist.integrity, attestations:.dist.attestations}}'
npm audit signatures @mindstone/mcp-server-<connector>@<X.Y.Z>
```

Expected: one attestation entry, signature verified.

Confirm `dispatch-catalog-sync` job ran green, that a `connector-published` event reached Rebel, and that the Rebel-side workflow opened a `catalog-sync/<connector>` PR against `dev`. The sibling Rebel plan owns the rest of that path.

**Stop condition for sub-wave A**: if any of the 4 fails signature verification, or if the dispatch-catalog-sync job fails, halt the wave and triage. The EMERGENCY_REVOKE runbook covers signature failures.

### 3.2. Sub-wave B — 16 mid-risk connectors (days 2-3)

Everything except the OAuth-heavy, the consolidator, and the multi-surface connector — and excluding the 4 already in sub-wave A and slack at 3.4. Specifically: `elevenlabs`, `freshdesk`, `gamma`, `google-analytics`, `kling`, `mixmax`, `nano-banana`, `napkin`, `outreach`, `quickbooks`, `retell-ai`, `runway`, `servicenow`, `workday`, `zendesk`, `browser-automation`.

Same per-connector procedure as sub-wave A. Batch the tag pushes 4-6 at a time to avoid overloading the maintainer-approval queue.

### 3.3. Sub-wave C — 3 high-touch connectors (day 4+)

`salesforce`, `office`, and `email-imap`.

These have the most consumer breakage surface:
- `salesforce` (OAuth, account state on disk, host-bridge mode)
- `office` (5-service consolidator: gmail/calendar/drive/docs/sheets; consolidator schema is what Rebel commit `92e9a6506`-equivalent flips would need to preserve verbatim). Blocker B1 above applies — the Rebel `officePackage.ts` PR must be staged before this tag fires.
- `email-imap` (1-package-to-3-surfaces — Blocker B2 above; auto-sync covers `bundled-custom-email`, manual M1 covers `bundled-icloud-mail` and `bundled-yahoo-mail`). The Rebel handoff plan W4-email-imap codifies the manual M1 sequence.

Hold for separate reviewer eyes and watch the consumer-side telemetry from the prior sub-waves before tagging.

### 3.4. Slack (special — bootstrap target, separate tag)

Slack has no `@mindstone-engineering` predecessor, so phase 4 (dual-publish + deprecate) does not apply. After phase 2's bootstrap, slack just needs phase 3. There's no migration burden on existing consumers (no legacy package to deprecate).

Tag slack alongside sub-wave A (day 1) but track it as a separate item — its auto-sync PR converts `bundled-slack` from `provider: bundled` (in-process) to `provider: rebel-oss`, which is structurally different from every other PR in the wave and warrants distinct review attention (W4 in the sibling plan covers the additional checks).

---

## Phase 4 — Dual-publish + deprecate legacy scope (per `MIGRATION.md` step 4)

Required for the 23 connectors that have a legacy `@mindstone-engineering/` predecessor AND that received a phase-3 OIDC publish. Slack is excluded (no legacy scope to dual-publish into). Hubspot is excluded (already dual-published at v0.1.2).

Apple-shortcuts is a special case: it has a legacy predecessor at `0.1.1` but already shipped on `@mindstone/` at `0.1.2` before this wave. The dual-publish step (bringing `@mindstone-engineering/mcp-server-apple-shortcuts` to `0.1.2`) is OPTIONAL per `MIGRATION.md`'s troubleshooting paragraph — consumers' existing lockfiles resolve `0.1.1` fine with a deprecation warning. The `npm deprecate` step (marking all legacy versions deprecated) is REQUIRED. Default to running both unless a maintainer explicitly skips the dual-publish for apple-shortcuts in the tracking issue.

For each connector freshly published on `@mindstone/`:

```sh
cd /tmp/dual && mkdir -p <connector> && cd <connector>
npm pack @mindstone/mcp-server-<connector>@<X.Y.Z>
tar -xzf mindstone-mcp-server-<connector>-<X.Y.Z>.tgz
cd package
# Replace the package name in package.json
sed -i.bak 's|"@mindstone/mcp-server-|"@mindstone-engineering/mcp-server-|g' package.json
rm package.json.bak
cd ..
tar -czf legacy-<connector>-<X.Y.Z>.tgz package
# 2FA prompt expected on each publish
npm publish ./legacy-<connector>-<X.Y.Z>.tgz --access public
# Mark every version under the legacy scope as deprecated
npm deprecate "@mindstone-engineering/mcp-server-<connector>@*" \
  "This package has moved to @mindstone/mcp-server-<connector>. See https://github.com/mindstone/mcp-servers/blob/main/MIGRATION.md"
```

23 dual-publishes (or 22 if the apple-shortcuts dual-publish is skipped) × ~3 min each = ~70 min, again serial because of 2FA per call. The `npm deprecate` step at the end of each is fast and can be batched in a follow-up script after all dual-publishes land.

**Exit criterion**: `npm view @mindstone-engineering/mcp-server-<connector> versions` shows the new version, and `npm view @mindstone-engineering/mcp-server-<connector> deprecated` reports the deprecation message for every version.

---

## Phase 5 — Verification

Single-pass, fully scripted, no human input:

```sh
# Per connector, verify the new scope is published + signed.
for c in <list of 24>; do
  v=$(node -p "require('./connectors/$c/package.json').version")
  printf "=== %s @ %s ===\n" "$c" "$v"
  npm view "@mindstone/mcp-server-$c@$v" --json \
    | jq -r '"  new-scope:    version=\(.version)  attestations=\(.dist.attestations | length // 0)"'
  npm audit signatures "@mindstone/mcp-server-$c@$v" 2>&1 \
    | grep -E '(verified|unsigned)' || true
  # Legacy parity (skip for slack)
  if [ "$c" != "slack" ]; then
    npm view "@mindstone-engineering/mcp-server-$c@$v" --json 2>/dev/null \
      | jq -r '"  legacy-scope: version=\(.version)  deprecated=\(.deprecated // "NOT SET")"' \
      || echo "  legacy-scope: MISSING"
  fi
done
```

Expected output per connector: `version` matches, `attestations` ≥ 1, signatures `verified`, legacy `deprecated` carries the migration message.

Any deviation halts. Roll back via `EMERGENCY_REVOKE.md` (`npm deprecate` is fast and reversible; `npm unpublish` is not allowed within the 72-hour window for any version other than the one just published).

---

## Phase 6 — End-of-wave checkpoint with Rebel

Note: Rebel coordination is continuous, not deferred to a final phase. The sibling plan's "During the wave" section (W1-W4) handles the per-PR review that opens automatically as each tag publishes in phase 3. Phase 6 below is the wave-end checkpoint, not the first handoff.

Trigger condition: phase 5 verification clean AND every auto-sync PR from phase 3 has been merged (or M1 manual flip has been applied for any that diverged).

Action:

- Post the end-of-wave summary to the Rebel maintainer channel per the sibling plan's "Notification points" section.
- Confirm the P1 catalog audit in the sibling plan returns 100% `@mindstone/...` for `rebel-oss` provider entries.
- Confirm the named on-call maintainer for the 7-day window is staffed; the window starts at the last `npm publish` time in phase 4.
- Open a calendar reminder for 2026-08-14 to execute `MIGRATION.md` step 5 (legacy scope publish-rights lockdown).

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `CATALOG_SYNC_TOKEN` still unset | Medium (was the case at hubspot release) | Catalog sync silently fails; Rebel maintainers manually flip every entry | G2 pre-flight check; if unset, plan stops until rotated |
| Bootstrap placeholder leaks to a consumer who does not pin | Low (placeholder is `0.0.0-bootstrap`, < real version) | Confused install warning, no behaviour break | `npm deprecate` placeholder immediately after publish |
| `catalog-entry.json` id mismatch causes parallel Rebel catalog entries | Medium (already happened for 5 of 6 existing manifests) | Duplicate entries in Rebel UI; legacy entry never retired | Phase 1.2 fixes ids before any tag fires |
| Trusted-publisher binding misconfigured for one of 22 new bindings | Low | `npm publish` returns 403 mid-wave; halt to fix that one | Per-binding verification on `/access` after each phase 2 bootstrap |
| A maintainer approves the `npm-publish` environment for the wrong commit | Low (gate is per-job, reviewer can decline) | Unintended version ships | `PUBLISH_APPROVAL_PROCESS.md` already requires reviewer != author; G1 confirms |
| Dual-publish 2FA token expires mid-wave | Low | Phase 4 stops; resume with re-auth | Run phase 4 in one sitting per maintainer; tokens last 24h |
| Office consolidator schema drift breaks Rebel's `bundledConfig.providerKeyMapping` | Low (import script preserves bundledConfig on upsert) | Office Connect/Sign-In stops working in Rebel | Sub-wave C delay; `validateBundledConfigInvariant` fires in Rebel CI before catalog state writes |
| `min-release-age=7` on a downstream host stalls fix-deploy | Medium | Cannot patch a broken release for 7 days via name-resolution | Hosts can pin a hot-fix by exact version + `--no-audit`; documented in `MIGRATION.md` |
| Office `officePackage.ts` constants not updated before catalog flip | High (default behaviour if B1 is missed) | Office sidecar fails to locate the managed install for every user who picks up the new catalog | B1 hard blocker — Office is in sub-wave C and the Rebel constants PR is sequenced explicitly |
| `email-imap` flip leaves 2 of 3 catalog entries on legacy package | High (default behaviour if B2 manual flip is missed) | iCloud Mail and Yahoo Mail surfaces continue using `@mindstone-engineering/...@0.2.2` indefinitely | B2 hard blocker — sibling plan W4-email-imap codifies the 2 manual M1 flips after the auto-sync PR for `bundled-custom-email` merges |
| Bootstrap-placeholder package has no `latest` tag after phase 2 | Low (window is bounded; consumers should not unpin in this window) | An unpinned `npm install @mindstone/mcp-server-<connector>` errors with "no latest version" between phase 2 and phase 3 for that connector | Document the gap explicitly in the tracking issue; alternatively, in phase 2, publish the real version directly with `--tag latest --provenance=false` (sacrifices OIDC attestation on one version per connector to skip the placeholder; consult security owner before adopting) |
| Connector quarantines on user machines during managed-MCP auto-upgrade | Medium | Specific connector unavailable until user retries; telemetry only exists for hubspot today | Phase 6 end-of-wave checkpoint includes a 7-day quarantine telemetry watch per connector via Rebel logs; add fast-follow telemetry hooks for other connectors in a separate plan |

---

## Rollback

Per `docs/EMERGENCY_REVOKE.md`. Summary:

- A signature-verification failure on any new-scope version → treat as P1 incident, `npm deprecate` the version with an explicit "do not install" message, notify consumers, and patch-bump-forward as the recovery path. Policy is no-unpublish-ever (consistent with `MIGRATION.md`): unpublishing breaks downstream lockfiles and is forbidden in the audit guidance even within npm's 72-hour grace window.
- A bad release that lints / runs but is functionally wrong → patch-bump and roll forward. The 7-day `min-release-age` cool-down means consumers with that setting haven't picked up the bad version yet; consumers without it can pin around the bad version once it is deprecated.
- Catalog drift between mcp-servers and Rebel → manual flip PR in Rebel that fixes the affected `bundled-*` entry in `resources/connector-catalog.json`, modeled on commit `92e9a6506` (hubspot bundled→rebel-oss) or `0cfce86db` (hubspot legacy→`@mindstone` scope flip). The sibling Rebel plan codifies this as M1.

---

## Sign-off

Two humans, neither being the author of any release commit in this wave:

- [ ] Pre-flight gates (G1-G5) verified by ____________ on ____________
- [ ] Phase 1 PR reviewed and merged by ____________ on ____________
- [ ] Phase 2 bootstrap sweep completed by ____________ on ____________
- [ ] Phase 3 sub-wave A approved by ____________ on ____________
- [ ] Phase 3 sub-wave B approved by ____________ on ____________
- [ ] Phase 3 sub-wave C approved by ____________ on ____________
- [ ] Phase 4 dual-publish + deprecate completed by ____________ on ____________
- [ ] Phase 5 verification clean, owner on 7-day call: ____________ until ____________
- [ ] Phase 6 handoff to Rebel acknowledged by ____________ on ____________

---

## Appendix — Full version table (verified 2026-05-15)

| Connector | Local | `@mindstone/` | `@mindstone-engineering/` | Phase 2 bootstrap? | Phase 4 dual-publish? |
|---|---|---|---|---|---|
| apple-shortcuts | 0.1.2 | 0.1.2 (live) | 0.1.1 | no | yes (catch-up — already on legacy at 0.1.1) |
| browser-automation | 0.1.7 | — | 0.1.6 | yes | yes |
| elevenlabs | 0.2.2 | — | 0.2.1 | yes | yes |
| email-imap | 0.2.3 | — | 0.2.2 | yes | yes |
| fathom | 0.2.3 | — | 0.2.2 | yes | yes |
| freshdesk | 0.2.2 | — | 0.2.1 | yes | yes |
| gamma | 0.3.2 | — | 0.3.1 | yes | yes |
| google-analytics | 0.1.1 | — | 0.1.0 | yes | yes |
| hubspot | 0.1.2 | 0.1.2 (live) | 0.1.2 | no | already done |
| humaans | 0.2.2 | — | 0.2.1 | yes | yes |
| kling | 0.3.2 | — | 0.3.1 | yes | yes |
| mixmax | 0.2.2 | — | 0.2.1 | yes | yes |
| nano-banana | 0.3.2 | — | 0.3.1 | yes | yes |
| napkin | 0.3.2 | — | 0.3.1 | yes | yes |
| office | 0.1.4 | — | 0.1.3 | yes | yes |
| outreach | 0.1.3 | — | 0.1.2 | yes | yes |
| pandadoc | 0.2.2 | — | 0.2.1 | yes | yes |
| quickbooks | 0.3.1 | — | 0.2.1 | yes | yes |
| retell-ai | 0.2.1 | — | 0.2.0 | yes | yes |
| runway | 0.3.2 | — | 0.3.1 | yes | yes |
| salesforce | 0.1.2 | — | 0.1.1 | yes | yes |
| servicenow | 0.2.2 | — | 0.2.1 | yes | yes |
| slack | 0.1.1 | — | — | yes | no (never on legacy) |
| talentlms | 0.2.2 | — | 0.2.1 | yes | yes |
| workday | 0.2.2 | — | 0.2.1 | yes | yes |
| zendesk | 0.3.2 | — | 0.3.1 | yes | yes |

Totals across all phases (26 connectors in `connectors/` minus `_template`):

- Phase 2 bootstrap (path A) — **24 placeholder publishes**: every connector except `hubspot` and `apple-shortcuts` (both already exist on `@mindstone/`).
- Phase 3 OIDC tag-push — **24 publishes**: every connector except `hubspot` and `apple-shortcuts`. Apple-shortcuts runs phase 3.0 catch-up dispatch instead (no re-publish).
- Phase 4 step 1 dual-publish (legacy scope) — **23 mandatory + 1 optional**: the 23 connectors from phase 3 that have a `@mindstone-engineering/` predecessor (everyone except `slack`), plus optionally `apple-shortcuts` to bring legacy parity from 0.1.1 → 0.1.2.
- Phase 4 step 2 legacy deprecate — **25 deprecations**: every connector except `slack` (no legacy package to deprecate). `hubspot` legacy deprecation must be re-run if it wasn't included in the original v0.1.2 ship.

---

## Cross-references

- [`MIGRATION.md`](../../MIGRATION.md) — per-package runbook this plan sequences across
- [`docs/PUBLISH_APPROVAL_PROCESS.md`](../PUBLISH_APPROVAL_PROCESS.md) — per-release human gate
- [`docs/EMERGENCY_REVOKE.md`](../EMERGENCY_REVOKE.md) — rollback path
- [`docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md`](../security/AUDIT_FOX-3319_tanstack_supply_chain.md) — threat model behind the trusted-publisher posture
- [`260515_rebel_catalog_handoff.md`](./260515_rebel_catalog_handoff.md) — Rebel-side coordination plan
- Rebel-side postmortem: `MindstoneRebel/docs/postmortems/260424_oss_catalog_sync_automation_never_worked_postmortem.md` — why the catalog dispatch was historically broken
- Rebel-side commit `92e9a6506` — the manual-flip pattern used for `bundled-hubspot`, modelled here for the rare case auto-sync diverges
