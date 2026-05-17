# Phase 0 implementer guide — FOX-3319 `@mindstone/` scope wave

**Status**: draft for colleague handoff
**Created**: 2026-05-17
**Architecture mode**: **MANUAL PUBLISH** (no CI publish path). All `npm publish` runs from the wave-lead's dev machine; catalog-sync dispatch fires from the same machine via `gh api` after each publish. `.github/workflows/publish.yml` has been removed from the repo as part of this pivot.
**Estimated effort**: ~3-4 hours total. Track 1 is mostly verification + one local-publish dry-run. Track 2 is two Rebel-side PRs and a smoke test.
**Pre-requisite**: PR #31 merged on `mcp-servers` `main` (2026-05-17, `0b68b9b`). Phase 1 is complete.
**Blocks**: Phase 2 (bootstrap npm publishes). Phase 0 must complete fully before any package is bootstrapped on `@mindstone/`.

### Where to record evidence
Create a tracking issue in `mindstone/mcp-servers` titled **"FOX-3319 Phase 0 sign-off"** before starting (label: `release-management`). Every "Output to capture" below means: paste the command output / URL into that issue as a comment. The sign-off table at the bottom of this guide gets filled in inside that issue.

```sh
gh issue create --repo mindstone/mcp-servers \
  --title "FOX-3319 Phase 0 sign-off" \
  --label release-management \
  --body "Tracking issue for Phase 0 pre-flight gates. See docs/plans/260517_PHASE_0_IMPLEMENTER_GUIDE.md."
```

### Escalation contacts (fill in before starting)
| Topic | Owner | Channel |
|---|---|---|
| mcp-servers maintenance / Track 1 | _________________ | _________________ |
| Rebel maintainers / R-gates | _________________ | _________________ |
| npm org admin (mindstone-engineering) | _________________ | _________________ |
| Security / supply-chain | _________________ | _________________ |

---

## TL;DR

Two independent tracks. Both must finish green before anyone publishes.

| Track | Owner | Items | Time | Where it runs |
|---|---|---|---|---|
| **Track 1** | mcp-servers wave-lead (publishes locally) | G2 (token), G3 (done), G5 (done), G6 (procedure dry-run) | ~30 min | `mindstone/mcp-servers` clone + your local npm + your local `gh` CLI |
| **Track 2** | Rebel maintainer | R1, R2 (done), R3, R4 (done), **R5/1**, R6 (optional), **R7** | ~3 hours | `mindstone/MindstoneRebel` repo |

Why several G-gates collapsed in this revision: with no CI publish job, the per-environment required-reviewer rule (G1) and the per-package OIDC Trusted Publisher binding (G4) become irrelevant. The wave-lead's npm 2FA challenge happens **interactively on their own terminal**, and the human gate is **the maintainer themself plus PR review on the version-bump commit**. Two-person review on the npm publish step itself is enforced via the `PUBLISH_APPROVAL_PROCESS.md` checklist (out of band, not via CI).

Two items in Track 2 are **load-bearing** and require code changes:
- **R5/1**: Office tolerant-locator PR on Rebel `dev`
- **R7**: Rebel `import-rebel-oss-catalog-entry.ts` preserve-all-unspecified patch on `dev`

If either is skipped or merged out-of-order, the wave ships regressions to existing Rebel users when Phase 3 fires.

---

## Context (read this first if you weren't on the prior conversation)

We're migrating 24 npm-published connectors from `@mindstone-engineering/mcp-server-*` to `@mindstone/mcp-server-*`. The mcp-servers repo holds the source for the packages; the Rebel app consumes them via its `resources/connector-catalog.json`. After each `npm publish` from the wave-lead's machine, the wave-lead fires a `repository_dispatch` event to Rebel (`event_type=connector-published`) which triggers `rebel-oss-catalog-sync.yml` to open a `catalog-sync/<connector>` PR on `dev`.

Phase 1 (PR #31, merged 2026-05-17) backfilled the per-connector `catalog-entry.json` manifests that the auto-sync workflow reads.

**Phase 0 is the pre-flight verification + Rebel-side defensive patches.** Phase 2 is the npm bootstrap (24 packages). Phase 3 is the actual release wave.

Full plan docs (read for context, not required to execute):
- `docs/plans/260515_finalise_mindstone_scope_publish.md` — full 7-phase wave plan (predates the manual-publish pivot; treat CI-publish references as superseded by G6 below)
- `docs/plans/260515_rebel_catalog_handoff.md` — Rebel coordination contract
- `docs/plans/260515_KICKOFF_CHECKLIST.md` — one-page checklist
- `MIGRATION.md` — per-package runbook (canonical)
- `docs/PUBLISH_APPROVAL_PROCESS.md` — per-release human gate (still applies in manual mode; just enforced via PR review + sign-off, not CI environment reviewers)
- `docs/EMERGENCY_REVOKE.md` — rollback procedure

---

## Pre-requisites (do this before starting either track)

### Tooling
- `gh` CLI ≥ 2.50 (we use 2.86), authenticated as a user with **write** access to `mindstone/mcp-servers` AND `repository_dispatch: write` (or equivalent) on `mindstone/MindstoneRebel`. The wave-lead's personal `gh auth` token typically covers this if they have repo access; verify in G2.
- `npm` ≥ 10. The wave-lead must be logged in as a publisher on the `@mindstone/` scope (`npm whoami` returns the configured publisher; `npm access list packages @mindstone` returns the existing `@mindstone/*` packages).
- `jq`
- `node` ≥ 22 (only needed for Track 1 G6 dry-run)

### Access checks
Run these four commands; all should succeed:

```sh
gh auth status                                              # confirms gh authentication
gh repo view mindstone/mcp-servers --json name              # confirms read access here
gh repo view mindstone/MindstoneRebel --json name           # confirms read access on Rebel
npm whoami                                                  # confirms npm login (expected: mindstone-engineering or whichever account holds @mindstone)
```

If the Rebel `gh repo view` returns 404, you don't have access yet — request from the Rebel maintainers before continuing on Track 2. Track 1 can proceed independently.

### Working directory assumptions
- `mcp-servers` clone at `/Users/harry/development/mcp-servers` (current branch: `main`, last commit: `0b68b9b`)
- Rebel clone at `/Users/harry/development/desktop/MindstoneRebel-1` (current branch: `dev`)

Adjust paths as needed.

---

## TRACK 1 — mcp-servers pre-flight (G2, G3, G5, G6)

Four items. Two are already done (G3, G5). One is a token verification (G2). One is a local procedure dry-run (G6). Total time ~30 min.

> **What happened to G1 and G4?**
>
> - **G1** (npm-publish GitHub Actions environment with required reviewer): N/A in manual-publish mode. No CI publish job exists → no environment to gate. The wave-lead's interactive npm 2FA challenge replaces the required-reviewer rule for the publish step itself. Branch protection on `main` (separate, not part of this guide) handles the version-bump PR review.
> - **G4** (per-package OIDC Trusted Publisher binding): N/A in manual-publish mode. We're publishing with the maintainer's npm credentials, not via GitHub Actions OIDC. Provenance attestations are still produced if the maintainer adds `--provenance` to the publish command (they generally won't, since that requires OIDC token mint inside a GitHub Action). Net effect: no Trusted Publisher configuration is needed for any of the 24 packages.

### G2. Wave-lead's `gh` CLI can fire `repository_dispatch` to Rebel

**Why it matters**: Every publish must be followed by a manual `repository_dispatch` to Rebel so the catalog-sync workflow opens a PR with the new version. If the wave-lead's `gh` token can't dispatch to Rebel, every publish needs a manual catalog flip on Rebel afterwards — 24 of those is unacceptable.

**How to verify** (this is a **safe** dispatch — uses a no-op event_type Rebel doesn't act on, just confirms HTTP 204):

```sh
# This will return 204 No Content on success. Rebel's workflow filters on
# event_type=connector-published, so the noop event_type below is dropped
# silently. We just want to confirm the API call is allowed.
gh api repos/mindstone/MindstoneRebel/dispatches \
  --method POST \
  -f event_type=fox-3319-phase-0-noop \
  -F 'client_payload[note]=Phase 0 G2 verification — safe to ignore' \
  --silent && echo "G2 PASS — dispatch allowed" || echo "G2 FAIL — token cannot dispatch"
```

**Pass criteria**:
- [ ] Command prints `G2 PASS`
- [ ] No workflow runs are triggered on Rebel (confirm by checking `gh run list --repo mindstone/MindstoneRebel --limit 3` — no new run for `fox-3319-phase-0-noop`)

**If it fails (403 / 404)**:
- Most likely cause: your personal `gh auth` token doesn't include the Rebel repo's dispatch permission. Run `gh auth refresh -h github.com -s repo` to re-grant `repo` scope, then re-test.
- If still failing: ask a Rebel admin to confirm you have at least Triage role (sufficient for `repository_dispatch`). If not, get added.
- Fallback (not recommended): create a fine-grained PAT scoped only to `repository_dispatch: write` on `mindstone/MindstoneRebel`, set it as a local env var (`export REBEL_DISPATCH_TOKEN=...`), and prefix dispatch calls with `GH_TOKEN=$REBEL_DISPATCH_TOKEN`. Document the rotation date in the sign-off issue.

**Output to capture**: stdout from the dispatch command (just the PASS line) + the empty `gh run list` confirming no spurious workflow ran.

---

### G3. CODEOWNERS team — STATUS: ✅ DONE

**Status** (verified 2026-05-17): `@mindstone/oss-maintainers` team created (id 17581413), `harryblam` added as maintainer, team granted push on `mindstone/mcp-servers`. CODEOWNERS file already references this team — no edits required.

**Re-confirm anytime** (optional):

```sh
gh api orgs/mindstone/teams/oss-maintainers | jq '{name, slug, members_count}'
gh api orgs/mindstone/teams/oss-maintainers/members | jq '.[].login'
```

Expected: team resolves, exactly one member (`harryblam`) for now. A second maintainer will be added before the wave window opens, per the project owner's plan.

**Pass criteria**:
- [x] Team resolves (no 404) — done
- [x] At least one human member — done (`harryblam`)
- [ ] Second human member added before Phase 3 tag day — TBD

**Output to capture**: paste the JSON output of both commands into the sign-off thread once the second member is added.

---

### G5. Phase 1 pre-flight — STATUS: ✅ DONE

PR #31 (merged 2026-05-17, `0b68b9b`) backfilled:
- All 26 `catalog-entry.json` files match the import script contract (`id: "bundled-<connector>"`, `verifiedSource` as repo URL string)
- Hubspot `server.json` aligned with package.json v0.1.2 (latent CI bug from `fa29c2e` resolved)
- `main` CI green

**One-command sanity check** (takes 5 seconds — re-run anytime):

```sh
gh run list --workflow=server-json-check.yml --branch=main --limit=1 --json conclusion --jq '.[0].conclusion'
```

Expected: `success`. If anything else, escalate before continuing — the wave cannot proceed with `main` red.

---

### G6. Manual-publish procedure — dry-run on a no-op publish

**Why it matters**: The wave-lead is about to do this 24 times for real in Phase 2 and then again for every Phase 3 sub-wave. Practice the full sequence end-to-end **once** on a low-risk package so any tooling surprises (auth prompts, missing `--access=public` defaults, npm 2FA flow timing, dispatch payload typos) surface here, not mid-wave.

**Canonical per-publish sequence**:

```sh
#
# Manual publish procedure for FOX-3319 wave
#
# Run from the connector directory. Replace <connector> and <version> as needed.
#
CONNECTOR=fathom                       # the connector dir under connectors/
NEW_VERSION=0.2.3-rc.0                 # the version you will publish (pre-release tags are safe for the dry-run)
NEW_PACKAGE='@mindstone/mcp-server-fathom'  # what name will be on npm

# 1. Get on a clean main with PR #31 merged in:
cd /Users/harry/development/mcp-servers
git checkout main
git pull --ff-only origin main

# 2. Sanity-check the connector dir is publish-ready:
cd connectors/$CONNECTOR
cat package.json | jq '.name, .version, .private, .scripts.prepublishOnly'

# Expected: name === @mindstone/mcp-server-<connector>, .private absent/false,
# prepublishOnly script present and idempotent.

# 3. Build + test the local artifact (every connector ships a `build` and `test` script):
npm run build
npm test

# 4. Publish to npm. The --access=public is REQUIRED for first-time publish under a new scope:
npm publish --access=public
# This will prompt for 2FA. Complete the WebAuthn (security key) or TOTP challenge.

# 5. Capture the published SHA of mcp-servers main for the dispatch payload:
cd ../..
MAIN_SHA=$(git rev-parse origin/main)

# 6. Fire the catalog-sync dispatch to Rebel:
gh api repos/mindstone/MindstoneRebel/dispatches \
  --method POST \
  -f event_type=connector-published \
  -F "client_payload[connector]=$CONNECTOR" \
  -F "client_payload[package]=$NEW_PACKAGE" \
  -F "client_payload[version]=$NEW_VERSION" \
  -F "client_payload[sha]=$MAIN_SHA"

# 7. Watch for the Rebel workflow run + the PR. Allow ~3 min:
sleep 30
gh run list --workflow=rebel-oss-catalog-sync.yml \
  --repo mindstone/MindstoneRebel \
  --limit 3 \
  --json conclusion,headBranch,createdAt,displayTitle,url
gh pr list --repo mindstone/MindstoneRebel \
  --head "catalog-sync/$CONNECTOR" \
  --json number,title,url
```

**Dry-run target choice**: use `fathom` with a `-rc.0` pre-release tag so the npm publish IS real, but a pre-release is npm-deletable for ~24h if anything goes wrong. **Do NOT** use this dry-run as the bootstrap publish — it must be deleted from npm after verification, then the real `0.2.3` (or appropriate version) bootstrap happens in Phase 2.

**Pass criteria** (all must hold):
- [ ] Step 3: build + test pass cleanly on a non-modified connector dir
- [ ] Step 4: `npm publish --access=public` returns success; new version visible on `https://www.npmjs.com/package/@mindstone/mcp-server-fathom` within ~1 min
- [ ] Step 6: dispatch returns 204 (no error)
- [ ] Step 7: a `catalog-sync/fathom` PR appears on Rebel `dev` within ~3 min
- [ ] PR diff is **exactly** a `mcpConfig.args[-1]` change. Tolerable additions: `+ verifiedSource` (always set by import script), `+ maturity` (set by import script if existing entry lacks it), `+ verified` (import script always sets `verified: true`). ANYTHING ELSE — particularly any touch to `setupFields`, `setupUrl`, `setupInstructions`, `callbackUrl`, `accountIdentity`, `platforms`, `contributors`, `bundledConfig`, `tools`, `popular`, `hidden`, `featured` — means R7 isn't merged or the script regressed.

**Cleanup after pass**:

```sh
# Close the catalog-sync PR (it points at a pre-release version we're not keeping):
gh pr list --repo mindstone/MindstoneRebel --head "catalog-sync/fathom" --json number --jq '.[0].number' | \
  xargs -I {} gh pr close {} --repo mindstone/MindstoneRebel \
    --comment "G6 dry-run sentinel for FOX-3319 Phase 0. Closing without merge — real fathom bootstrap will happen in Phase 2 with version 0.2.3."

# Delete the branch:
gh api -X DELETE repos/mindstone/MindstoneRebel/git/refs/heads/catalog-sync/fathom

# Unpublish the pre-release from npm (must be done within 24h or it becomes permanent):
npm unpublish @mindstone/mcp-server-fathom@0.2.3-rc.0
```

**If it fails**:
- Step 4 fails with 402/403 → npm scope permissions wrong. Confirm `npm access list packages @mindstone` includes the connector or that you can create new packages under the scope.
- Step 4 prompts for OTP but you only have WebAuthn → publish must be done in a terminal that supports the system browser launch for WebAuthn (recent npm clients on macOS handle this; Linux may need additional setup). If WebAuthn is unworkable, switch the npm account to TOTP via npmjs.com → Account → Two-Factor Authentication. (See G4 notes in the prior version of this guide for the WebAuthn-only caveat.)
- Step 6 fails 404 → G2 token doesn't have dispatch on Rebel. Fix G2 first.
- Step 7: workflow runs but fails at "Verify catalog-entry.json exists" → the SHA you passed is wrong (you passed local commit, not `origin/main`). Re-run with the correct SHA.
- Step 7: workflow runs but PR diff touches forbidden fields → R7 isn't merged. Stop and finish Track 2 R7 first.

**Output to capture**:
- `npm publish` output (with the published version tag visible)
- Dispatch HTTP response (should be silent on success)
- Workflow run URL
- PR URL + `gh pr diff` output
- Cleanup confirmation (PR closed, branch deleted, pre-release unpublished)

---

### Track 1 exit criteria

Before declaring Track 1 done:

- [ ] G2 passes (dispatch returns 204)
- [ ] G3 second team member added (deferred ok until immediately before Phase 3)
- [ ] G5 sanity check returns `success` (`main` green)
- [ ] G6 dry-run completes end-to-end on `fathom@0.2.3-rc.0`, PR diff is clean, all cleanup steps done
- [ ] Output from each gate's verification commands posted to the Phase 0 sign-off thread
- [ ] Named maintainer for the 7-day post-wave window confirmed and available

---

## TRACK 2 — Rebel handoff (R1-R7)

Seven items. R5/1 and R7 are load-bearing and require Rebel-side code changes (PRs). Others are verifications. This track is **unchanged** by the manual-publish pivot — the safety nets it installs guard against malformed catalog-sync PRs and Office-sidecar regressions regardless of who fires the publish.

### R1. Synthetic-dispatch smoke test

**Why it matters**: The dispatch → sync workflow has never been observed working end-to-end. Both prior `@mindstone/` releases (hubspot, apple-shortcuts) bypassed it. We need to prove it works before relying on it for 24 publishes.

> Note: G6 above also exercises this same end-to-end path with a real publish. If you've completed G6 successfully, R1 is **already proven** — you can skip the synthetic-only R1 below and reference the G6 evidence in the sign-off. R1 is kept as a separate option for cases where you want to verify the dispatch path before publishing anything real.

**Prerequisites** (all must already be true before running R1):
1. G2 passed — wave-lead's `gh` can dispatch
2. `mcp-servers main` contains `connectors/fathom/catalog-entry.json` (true as of PR #31 merge, `0b68b9b`)
3. **R5/1 PR merged on Rebel `dev`** (otherwise the Office tolerant-locator safety net isn't in place — won't break R1 itself but you should not run R1 until both load-bearing patches are live)
4. **R7 PR merged on Rebel `dev`** (otherwise the diff will contain dropped fields and R1 will fail its acceptance criteria)

**How to verify**:

```sh
# Get the current mcp-servers main SHA (the synthetic payload must point at a SHA
# where connectors/fathom/catalog-entry.json exists — true after PR #31 merged).
cd /Users/harry/development/mcp-servers
git fetch origin main
MAIN_SHA=$(git rev-parse origin/main)
echo "Will use SHA: $MAIN_SHA"

# Fire a synthetic dispatch. The package name uses the LEGACY scope on purpose,
# so the resulting catalog-sync PR is a sentinel we recognise and can close
# without merging.
gh api repos/mindstone/MindstoneRebel/dispatches \
  --method POST \
  -f event_type=connector-published \
  -F 'client_payload[connector]=fathom' \
  -F 'client_payload[package]=@mindstone-engineering/mcp-server-fathom' \
  -F 'client_payload[version]=0.2.2-synthetic' \
  -F "client_payload[sha]=$MAIN_SHA"

# Watch for the workflow run (give it ~30 seconds to register)
sleep 30
gh run list --workflow=rebel-oss-catalog-sync.yml \
  --repo mindstone/MindstoneRebel \
  --limit 3 \
  --json conclusion,headBranch,createdAt,displayTitle,url
```

Expected: a new workflow run appears, completes with `conclusion: "success"` within ~3 min, and a new PR titled `chore(catalog): sync fathom v0.2.2-synthetic from rebel-oss` (or similar) appears on Rebel `dev`.

**Pass criteria** (all must hold):
- [ ] Workflow run appears within 1 min of the dispatch
- [ ] Workflow completes successfully
- [ ] PR opens on Rebel `dev` within ~2 min of workflow completion
- [ ] PR diff is **exactly** a `mcpConfig.args[-1]` change (same allow-list as G6).

**Cleanup after pass**:

```sh
gh pr list --repo mindstone/MindstoneRebel --head "catalog-sync/fathom" --json number,title,url
gh pr close <PR_NUMBER> --repo mindstone/MindstoneRebel \
  --comment "Synthetic dispatch sentinel from FOX-3319 Phase 0 R1 smoke test. Closing without merge."
gh api -X DELETE repos/mindstone/MindstoneRebel/git/refs/heads/catalog-sync/fathom
```

**If it fails**: same failure modes as G6. Fix the underlying issue and re-run.

**Output to capture**: workflow run URL + PR URL + diff screenshot (or `gh pr diff` output).

---

### R2. Sync workflow checks out the new org

**Status**: ✅ **VERIFIED** per `docs/plans/260515_rebel_catalog_handoff.md` (audit on 2026-05-15).

If you want to re-confirm:

```sh
gh api repos/mindstone/MindstoneRebel/contents/.github/workflows/rebel-oss-catalog-sync.yml \
  | jq -r '.content' | base64 --decode \
  | grep -A 2 'Checkout mcp-servers'
```

Expected: `repository: mindstone/mcp-servers` (not `mindstone-engineering/mcp-servers`).

**Pass criteria**:
- [ ] Workflow uses `repository: mindstone/mcp-servers`

Note: the PR body still has a cosmetic link to the legacy org URL. This is a separate follow-up; does NOT block the wave.

---

### R3. Rebel `dev` branch protection allows the sync bot

**Why it matters**: The `peter-evans/create-pull-request` action pushes a new `catalog-sync/<connector>` branch and opens a PR. If Rebel `dev`'s branch protection rejects either the push or the PR creation, every auto-sync silently fails.

**How to verify**:

```sh
gh api repos/mindstone/MindstoneRebel/branches/dev/protection \
  | jq '{
      required_linear_history: .required_linear_history.enabled,
      required_pull_request_reviews: .required_pull_request_reviews,
      restrictions: .restrictions,
      enforce_admins: .enforce_admins.enabled
    }'
```

**Pass criteria** (all must hold):
- [ ] `required_linear_history.enabled: false` OR not present (the action sometimes pushes merge-commits)
- [ ] `restrictions` is `null` OR includes the GitHub Actions bot / `peter-evans/create-pull-request`-related identity. If `restrictions` is set, the bot's identity must be in `restrictions.users` or `restrictions.apps`.
- [ ] `required_pull_request_reviews.required_approving_review_count ≥ 1` — this is the human gate. The bot can open PRs but cannot self-approve.

**If it fails**:
- `required_linear_history: true` → disable in branch protection settings, or add an exception for `catalog-sync/*` branches.
- `restrictions` blocks the bot → add `peter-evans-create-pull-request[bot]` or the equivalent GitHub Apps identity to the allowlist.

**Output to capture**: full JSON output from the API call.

---

### R4. Import script preserves `bundledConfig` on upsert

**Status**: ✅ **VERIFIED** per audit on 2026-05-15. The current script at `mindstone/MindstoneRebel/scripts/import-rebel-oss-catalog-entry.ts:212-225` preserves `bundledConfig`, `tools`, and curation fields. The `validateBundledConfigInvariant` guard fires before write.

R4 is conceptually folded into R7 — the broader preserve-all patch covers `bundledConfig` automatically as a subset of "preserve every field not in the new entry."

If you want to re-confirm independently:

```sh
cd /Users/harry/development/desktop/MindstoneRebel-1
sed -n '200,230p' scripts/import-rebel-oss-catalog-entry.ts
```

Look for explicit preservation logic for `bundledConfig`. Confirmed present 2026-05-15.

---

### R5. Office package-constants tolerance (HARD BLOCKER — load-bearing PR)

**Why it matters**: `mindstone/MindstoneRebel/src/shared/sidecar/officePackage.ts` hardcodes the legacy scope in four constants. If the catalog flip lands before the constants update, every Office user breaks: the sidecar can't locate the managed install.

R5 has three sub-PRs:
- **R5 step 1 (tolerant locator)** — must merge on `dev` BEFORE Phase 3 tag for office fires. **This is the gate.**
- R5 step 2 (constants bump to new scope/version)
- R5 step 3 (snapshot test updates)

Steps 2 + 3 are Phase 3 timing concerns (must land in the same Rebel deploy window as the office auto-sync PR), not Phase 0. Phase 0 only requires step 1.

**R5 step 1 — Required Rebel PR**

PR title: `fix(office): tolerate both legacy and new scope during FOX-3319 migration`

**Why the patch needs two layers (read this carefully — the obvious fix is wrong)**:

`src/main/services/officeSidecarManager.ts:256` calls:

```ts
const metadata = await installService.getMetadata(OFFICE_MCP_PACKAGE_SPEC);
if (!metadata) {
  throw new OfficeSidecarError(
    `Office managed install not found for ${OFFICE_MCP_PACKAGE_SPEC}. ...`
  );
}
```

`OFFICE_MCP_PACKAGE_SPEC` resolves to `@mindstone-engineering/mcp-server-office@0.1.3` today. For a user whose machine has only the **new-scope** install (`@mindstone/mcp-server-office@0.1.4` after Phase 3 sub-wave C), `getMetadata` returns null and the sidecar throws *before* reaching the path-segment locator at lines 273/286. A patch that only makes `OFFICE_MCP_PACKAGE_PATH_SEGMENTS` tolerant doesn't fix anything — the throw happens earlier.

The PR must therefore introduce candidate fallback at **both** layers: package-spec lookup AND path-segment resolution.

**Files touched**:
1. `src/shared/sidecar/officePackage.ts` — introduce `OFFICE_MCP_PACKAGE_SPEC_CANDIDATES` (array of `{name, version, pathSegments}` triples). Keep existing constants as exports for backward compat (other files import them).
2. `src/main/services/officeSidecarManager.ts:256-300` — replace the single-spec lookup with iteration over candidates. The first candidate whose `getMetadata` returns non-null wins; its `pathSegments` are then used in lines 273/286.

**Suggested diff for `officePackage.ts`**:

```diff
 export const OFFICE_MCP_PACKAGE_NAME = '@mindstone-engineering/mcp-server-office';
 export const OFFICE_MCP_PACKAGE_VERSION = '0.1.3';
 export const OFFICE_MCP_PACKAGE_SPEC = `${OFFICE_MCP_PACKAGE_NAME}@${OFFICE_MCP_PACKAGE_VERSION}`;
 export const OFFICE_MCP_PACKAGE_PATH_SEGMENTS = ['node_modules', '@mindstone-engineering', 'mcp-server-office'] as const;
+
+/**
+ * FOX-3319: during the scope migration, the catalog and the constants above
+ * can be out of phase by one Rebel deploy window. This candidate list lets
+ * the sidecar locate the managed install regardless of which scope is on disk.
+ */
+export const OFFICE_MCP_PACKAGE_SPEC_CANDIDATES = [
+  {
+    name: '@mindstone/mcp-server-office',
+    version: '0.1.4',
+    spec: '@mindstone/mcp-server-office@0.1.4',
+    pathSegments: ['node_modules', '@mindstone', 'mcp-server-office'] as const,
+  },
+  {
+    name: OFFICE_MCP_PACKAGE_NAME,
+    version: OFFICE_MCP_PACKAGE_VERSION,
+    spec: OFFICE_MCP_PACKAGE_SPEC,
+    pathSegments: OFFICE_MCP_PACKAGE_PATH_SEGMENTS,
+  },
+] as const;
```

**Suggested diff for `officeSidecarManager.ts` (~lines 256-300)**:

```diff
-const metadata = await installService.getMetadata(OFFICE_MCP_PACKAGE_SPEC);
-if (!metadata) {
-  throw new OfficeSidecarError(
-    `Office managed install not found for ${OFFICE_MCP_PACKAGE_SPEC}. ...`
-  );
-}
+let metadata: ManagedMcpInstallMetadata | null = null;
+let resolvedCandidate: typeof OFFICE_MCP_PACKAGE_SPEC_CANDIDATES[number] | null = null;
+for (const candidate of OFFICE_MCP_PACKAGE_SPEC_CANDIDATES) {
+  const m = await installService.getMetadata(candidate.spec);
+  if (m) {
+    metadata = m;
+    resolvedCandidate = candidate;
+    break;
+  }
+}
+if (!metadata || !resolvedCandidate) {
+  throw new OfficeSidecarError(
+    `Office managed install not found. Searched: ${OFFICE_MCP_PACKAGE_SPEC_CANDIDATES.map(c => c.spec).join(', ')}. Ensure the managed install has completed.`,
+  );
+}
```

Then below at line 273 and 286 (currently `...OFFICE_MCP_PACKAGE_PATH_SEGMENTS`):

```diff
-  ...OFFICE_MCP_PACKAGE_PATH_SEGMENTS,
+  ...resolvedCandidate.pathSegments,
```

(`officeSidecarManager.ts` already imports `node:fs/promises as fsp` not bare `fs`.)

**Tests the PR must include** (vitest):

1. **Unit test**: mock `installService.getMetadata` to return non-null for the new spec, null for the legacy spec. Assert the manager uses the new pathSegments.
2. **Unit test**: mock `getMetadata` to return non-null for legacy, null for new. Assert the manager uses the legacy pathSegments.
3. **Unit test**: both available — assert new wins (first candidate in the array).
4. **Unit test**: both null — assert the `OfficeSidecarError` is thrown with a message that lists both specs tried.

**Pass criteria** (all must hold):
- [ ] PR opened against Rebel `dev`
- [ ] All four unit tests above (or equivalent) added and pass
- [ ] `npm run test` green on the PR
- [ ] PR reviewed and merged to Rebel `dev`
- [ ] After merge, on a freshly-checked-out `dev`:
  - [ ] Manual smoke: simulate a new-only install layout — Office sidecar startup succeeds
  - [ ] Manual smoke: simulate legacy-only install layout — Office sidecar startup succeeds
  - [ ] Manual smoke: simulate empty `node_modules` — Office sidecar throws with the new error message listing both specs

**Output to capture**: PR URL + merge SHA + green test run URL.

---

### R6. `bundledInboxBridge.ts` Salesforce fallback (OPTIONAL — opportunistic)

**Status**: ⚠️ **DEFER**. Low priority, does NOT block any sub-wave.

`src/main/services/bundledInboxBridge.ts:~2023` has a hardcoded legacy-scope fallback for new users with no prior config:

```ts
args: existing?.args ?? ['-y', '@mindstone-engineering/mcp-server-salesforce'],
```

During the 90-day deprecation window, the legacy scope still serves. After lockdown (day 90), the package still installs but with a deprecation warning. Net regression risk: zero.

Update opportunistically in any Rebel PR that touches Salesforce code. Track as a follow-up issue; do not block Phase 0 on it.

**Pass criteria**: open a Rebel tracking issue titled `chore(salesforce): remove hardcoded legacy-scope fallback in bundledInboxBridge.ts (FOX-3319 follow-up)`. Link it in the Phase 0 sign-off thread.

---

### R7. `upsertEntry` preserve-all-unspecified shallow merge (HARD BLOCKER — load-bearing PR)

**Why it matters**: The current `scripts/import-rebel-oss-catalog-entry.ts` `upsertEntry` only preserves `popular`, `hidden`, `featured`, `tools`, `bundledConfig`, and `mcpConfig.env`. Every other field in the existing catalog entry that isn't set by the new entry gets dropped. The 2026-05-15 dry-run confirmed the dropped fields include `setupFields.envVar`, `setupUrl`, `setupInstructions`, `setupUrlBehavior`, `setupUrlButtonLabel`, `callbackUrl`, `platforms`, `contributors`, and `accountIdentity` — all consumed by Settings UI or runtime. After the first auto-sync for ~20 connectors, the Settings UI breaks.

**Required Rebel PR**

PR title: `fix(catalog-import): preserve all unspecified fields on upsert + conditional buildCatalogEntry (FOX-3319)`

**Files touched**:
1. `scripts/import-rebel-oss-catalog-entry.ts` — three changes:
   - Replace the unconditional object literal in `buildCatalogEntry` (~lines 183-220) with conditional field-setting. Currently `accountIdentity` is set unconditionally at ~line 204 — that's the load-bearing bug; the manifest doesn't carry it, so existing values get overwritten with `undefined`.
   - Replace the per-field preserve list in `upsertEntry` (~lines 225-263) with a generic shallow merge.
   - **Export `upsertEntry` and `buildCatalogEntry`** (they are currently file-private, line 183 and 225). The regression test below needs them.
2. `scripts/__tests__/import-rebel-oss-catalog-entry.test.ts` — add a regression test using vitest (the project runs `vitest run` as its test command).

**Suggested patch for `import-rebel-oss-catalog-entry.ts`**:

```ts
export function buildCatalogEntry(
  manifest: CatalogEntryManifest,
  opts: { npmPackage: string; version: string },
): CatalogConnector {
  const entry: Record<string, unknown> = {
    provider: 'rebel-oss',
    mcpConfig: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', `${opts.npmPackage}@${opts.version}`],
    },
  };
  for (const f of ['id','name','description','category','icon','maturity','verifiedSource','requiresSetup'] as const) {
    if (manifest[f] !== undefined) entry[f] = manifest[f];
  }
  if (!('verified' in entry)) entry.verified = true;
  if (manifest.accountIdentity !== undefined) entry.accountIdentity = manifest.accountIdentity;
  if (manifest.contributors && manifest.contributors.length > 0) entry.contributors = manifest.contributors;
  if (manifest.setupFields) {
    entry.setupFields = manifest.setupFields.map(f => ({
      id: f.key,
      label: f.label,
      type: f.type,
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    }));
  }
  return entry as CatalogConnector;
}

export function upsertEntry(catalog: ConnectorCatalog, newEntry: CatalogConnector): boolean {
  const existingIndex = catalog.connectors.findIndex(c => c.id === newEntry.id);
  if (existingIndex === -1) {
    catalog.connectors.push(newEntry);
    return false;
  }
  const existing = catalog.connectors[existingIndex];

  for (const [k, v] of Object.entries(existing)) {
    if (!(k in newEntry)) {
      (newEntry as Record<string, unknown>)[k] = v;
    }
  }
  if (existing.mcpConfig?.env && newEntry.mcpConfig && !newEntry.mcpConfig.env) {
    newEntry.mcpConfig.env = existing.mcpConfig.env;
  }

  catalog.connectors[existingIndex] = newEntry;
  return true;
}
```

**Regression test the PR MUST include** (`scripts/__tests__/import-rebel-oss-catalog-entry.test.ts`, vitest):

```ts
import { describe, expect, it } from 'vitest';
import { buildCatalogEntry, upsertEntry } from '../import-rebel-oss-catalog-entry';

describe('upsertEntry — FOX-3319 preserve-all-unspecified', () => {
  it('preserves load-bearing fields the manifest does not carry', () => {
    const existing = {
      id: 'bundled-fathom',
      name: 'Fathom',
      provider: 'rebel-oss',
      setupFields: [
        { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'FATHOM_API_KEY' },
      ],
      setupUrl: 'https://fathom.video/oauth/authorize',
      setupInstructions: 'Visit fathom.video to generate an API key',
      setupUrlBehavior: 'newTab',
      setupUrlButtonLabel: 'Connect Fathom',
      callbackUrl: 'rebel://oauth/fathom/callback',
      platforms: ['darwin', 'win32'],
      accountIdentity: 'email',
      contributors: [{ name: 'Alice', github: 'alice' }],
      bundledConfig: { authType: 'apiKey', serverName: 'fathom' },
      tools: [{ name: 'list_meetings' }],
      popular: true,
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-fathom@0.2.2'],
        env: { FATHOM_API_KEY: '${apiKey}' },
      },
    };
    const manifest = {
      id: 'bundled-fathom',
      name: 'Fathom',
      description: 'Fathom meeting transcripts',
      category: 'productivity',
      icon: 'video',
      maturity: 'stable',
      verifiedSource: 'https://github.com/mindstone/mcp-servers',
      requiresSetup: true,
    };
    const newEntry = buildCatalogEntry(manifest, {
      npmPackage: '@mindstone/mcp-server-fathom',
      version: '0.2.3',
    });
    const catalog = { connectors: [existing] } as any;
    const wasUpdate = upsertEntry(catalog, newEntry);

    expect(wasUpdate).toBe(true);
    const result = catalog.connectors[0];

    expect(result.setupFields[0].envVar).toBe('FATHOM_API_KEY');
    expect(result.setupUrl).toBe('https://fathom.video/oauth/authorize');
    expect(result.setupInstructions).toBe('Visit fathom.video to generate an API key');
    expect(result.setupUrlBehavior).toBe('newTab');
    expect(result.setupUrlButtonLabel).toBe('Connect Fathom');
    expect(result.callbackUrl).toBe('rebel://oauth/fathom/callback');
    expect(result.platforms).toEqual(['darwin', 'win32']);
    expect(result.accountIdentity).toBe('email');
    expect(result.contributors).toEqual([{ name: 'Alice', github: 'alice' }]);
    expect(result.bundledConfig.authType).toBe('apiKey');
    expect(result.tools[0].name).toBe('list_meetings');
    expect(result.popular).toBe(true);
    expect(result.mcpConfig.env).toEqual({ FATHOM_API_KEY: '${apiKey}' });
    expect(result.mcpConfig.args).toEqual(['-y', '@mindstone/mcp-server-fathom@0.2.3']);
    expect(result.verifiedSource).toBe('https://github.com/mindstone/mcp-servers');
    expect(result.verified).toBe(true);
  });
});
```

If exporting `upsertEntry` / `buildCatalogEntry` is rejected on review grounds, the alternative is a **CLI integration test** that uses `spawnSync` to invoke the script end-to-end. Either approach satisfies R7.

**Pass criteria** (all must hold):
- [ ] PR opened against Rebel `dev`
- [ ] Regression test (or equivalent) included and passes
- [ ] PR reviewed and merged
- [ ] After merge, G6 dry-run (or R1 synthetic dispatch) produces a PR with **only** `mcpConfig.args[-1]` + `verifiedSource` (+ optional `maturity`, `verified`) changes

**Note on merge ordering with R5**: R5/1 and R7 are independent and can merge in either order. Both must be on `dev` before G6 or R1 is run.

**Output to capture**: PR URL + merge SHA + green test run URL + G6/R1 post-merge output.

---

### Track 2 exit criteria

Before declaring Track 2 done:

- [ ] R1 OR G6 produces a clean PR (one is enough — G6 is preferred since it doubles as the procedure dry-run)
- [ ] R2 verified (already done per audit)
- [ ] R3 verified (branch protection allows the sync bot)
- [ ] R4 verified (already done per audit, folded into R7)
- [ ] R5/1 PR merged on Rebel `dev`, snapshot tests green
- [ ] R6 deferred (tracking issue opened on Rebel)
- [ ] R7 PR merged on Rebel `dev`, regression test green
- [ ] Sentinel PRs from R1/G6 closed without merge (cleanup)
- [ ] Pre-release npm artifact from G6 unpublished within 24h
- [ ] All Rebel-side merge SHAs posted to the Phase 0 sign-off thread

---

## Phase 0 done — what unlocks next

Once both tracks are green:

| Next action | Owner | Time | Trigger |
|---|---|---|---|
| **Phase 2 bootstrap publishes** (24 packages, local) | wave-lead | ~2h serial with 2FA prompts | Track 1 + Track 2 exit criteria green (specifically: G6 passed + R5/1 merged + R7 merged) |
| **Phase 3.0 apple-shortcuts catch-up dispatch** | wave-lead | ~15 min (dispatch + Rebel PR review) | Same trigger as Phase 2 |
| **Phase 3.1 sub-wave A (4 connectors)** | wave-lead | ~1 day | Phase 2 complete for sub-wave A's 4 packages |

Phase 3 sub-wave C cannot start until R5 step 2 + step 3 PRs are merged on Rebel `dev` AND `office-v0.1.4` is on npm. That sequencing is documented in the main wave plan (`docs/plans/260515_finalise_mindstone_scope_publish.md` section B1).

> **Reminder**: Phases 2 and 3 publishes always run from the wave-lead's dev machine. There is no CI publish path. Each publish is followed by a manual `gh api ... dispatches` call (the G6 procedure) to fire the catalog-sync workflow on Rebel.

---

## Escalation

If you hit something not covered here:

- **CI failure on mcp-servers `main`** → check `.github/workflows/server-json-check.yml`. If the `validate` job is failing, run the local equivalent: `for d in connectors/*/; do node -e "const s=require('./${d}server.json'); const p=require('./${d}package.json'); if(s.version!==p.version) console.log('DRIFT', '${d}', s.version, p.version);"; done`. The hubspot drift was the latent one; if others appear, escalate.

- **Rebel R-gate appears verified but G6/R1 still fails** → most likely the patched workflow on Rebel hasn't propagated yet (GitHub workflows for `workflow_dispatch` / `repository_dispatch` are pulled from the default branch — check that the workflow is on `dev` or `main` per Rebel's configuration). Wait 5 min and retry.

- **Dispatch returns 204 but no workflow appears on Rebel** → the workflow's `repository_dispatch` types filter is more specific than `connector-published`, or the workflow file isn't on the default branch. Inspect `gh api repos/mindstone/MindstoneRebel/contents/.github/workflows/rebel-oss-catalog-sync.yml` and check the `on:` block.

- **R7 regression test passes but G6/R1 smoke shows unexpected diff** → there's a non-`upsertEntry` mutation point in the import script (e.g. `validateCatalogImport.ts` or a sibling). Diff the catalog-sync PR carefully against the synthetic fathom entry. Escalate if the diff includes fields not predictable from the synthetic input.

- **Office tolerant-locator PR fails snapshot tests** → expected; update the snapshots and document each change in the PR body so reviewers can verify each diff isn't a regression in disguise.

- **npm publish fails with "you need to log in" on a fresh terminal** → `npm login` re-establishes the session. WebAuthn-only accounts launch the system browser; TOTP accounts prompt for the 6-digit code in the terminal.

---

## Sign-off

| Item | Verified by | When | Evidence |
|---|---|---|---|
| G2 dispatch token | ___________ | _______ | _______ |
| G3 CODEOWNERS team | harryblam (creator) | 2026-05-17 | team id 17581413, `harryblam` member; second member TBD |
| G5 Phase 1 PR merged | n/a (PR #31, 2026-05-17, `0b68b9b`) | done | https://github.com/mindstone/mcp-servers/pull/31 |
| G6 manual-publish dry-run | ___________ | _______ | _______ |
| R1 synthetic dispatch smoke (optional if G6 done) | ___________ | _______ | _______ |
| R2 sync workflow checks out new org | n/a (verified 2026-05-15) | done | `docs/plans/260515_rebel_catalog_handoff.md` R2 |
| R3 Rebel dev branch protection | ___________ | _______ | _______ |
| R4 bundledConfig preserved | n/a (verified 2026-05-15; subsumed by R7) | done | `docs/plans/260515_rebel_catalog_handoff.md` R4 |
| R5/1 Office tolerant-locator PR | ___________ | _______ | _______ |
| R6 bundledInboxBridge tracking issue | ___________ (deferred) | _______ | _______ |
| R7 upsertEntry preserve-all patch | ___________ | _______ | _______ |
| **Phase 0 complete — Phase 2 unlocked** | ___________ | _______ | _______ |
