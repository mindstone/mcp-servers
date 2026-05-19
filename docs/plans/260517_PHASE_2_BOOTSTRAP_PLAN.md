# Phase 2 bootstrap plan + publish tracker — FOX-3319

**Status**: 23/24 published as of 2026-05-19. Office held back pending Rebel R5/1 + R5/2 + R5/3 on `dev`. Catalog-sync dispatches to Rebel still pending R7 merge — once R7 lands, fire `gh api ... dispatches` for all 23 published connectors and watch the resulting catalog-sync PRs.
**Created**: 2026-05-17
**Last updated**: 2026-05-19 (slack 0.1.2 published, closing the security-patch sub-wave)
**Owner**: wave-lead (publishes locally from dev machine)
**Mode**: manual `npm publish` per `docs/PUBLISH_APPROVAL_PROCESS.md`, followed by `gh api ... dispatches` to Rebel.

---

## Wave totals

| Category | Count | Action |
|---|---|---|
| Already on `@mindstone/` at parity with local | 2 (apple-shortcuts, hubspot) | None — done in earlier wave bursts |
| Bootstrap publish from legacy parity | 23 | `npm publish` once each, +1 patch version above legacy |
| Fresh-fresh (404 on both scopes) | 1 (slack) | `npm publish` once at 0.1.1 |
| **Total publish operations needed** | **24** | sequential, ~5 min each = ~2h serial |

---

## npm scope state (verified 2026-05-17)

- `@mindstone/` org: 1 owner (`mindstone-engineering`), 1 team (`@mindstone:developers`)
- Current `@mindstone/` packages: 2 (apple-shortcuts, hubspot)
- npm publisher account: `mindstone-engineering` (email: engineering@mindstone.com)
- 2FA mode: WebAuthn / security-key only (verified earlier this session). `npm publish` from CLI launches the system browser for the security-key challenge. TOTP is not available on this account.
- `NPM_TOKEN` repo secret: **not used by manual-publish mode** (publish happens locally with `npm whoami` session)

### Single-point-of-failure risk

**Only one human can publish under `@mindstone/` today.** If `mindstone-engineering` is locked out (lost security key, compromised account), every release stalls. Mitigation: add a second `@mindstone/` org member with `developer` role on the `developers` team before Phase 3 tag day. Track in `oss-maintainers` team coordination.

---

## Per-package publish plan

Format: `connector` | `local_pkg_ver` (target) | `legacy_npm_latest` | `new_npm_state` | `action`

| Connector | Target version | Legacy latest | New scope state | Action |
|---|---|---|---|---|
| apple-shortcuts | 0.1.2 | 0.1.1 | exists @ 0.1.2 | DONE |
| hubspot | 0.1.2 | 0.1.2 | exists @ 0.1.2 | DONE |
| browser-automation | 0.1.7 | 0.1.6 | 404 | bootstrap |
| elevenlabs | 0.2.2 | 0.2.1 | 404 | bootstrap |
| email-imap | 0.2.3 | 0.2.2 | 404 | bootstrap |
| fathom | 0.2.3 | 0.2.2 | 404 | bootstrap |
| freshdesk | 0.2.2 | 0.2.1 | 404 | bootstrap |
| gamma | 0.3.2 | 0.3.1 | 404 | bootstrap |
| google-analytics | 0.1.1 | 0.1.0 | 404 | bootstrap |
| humaans | 0.2.2 | 0.2.1 | 404 | bootstrap |
| kling | 0.3.2 | 0.3.1 | 404 | bootstrap |
| mixmax | 0.2.2 | 0.2.1 | 404 | bootstrap |
| nano-banana | 0.3.2 | 0.3.1 | 404 | bootstrap |
| napkin | 0.3.2 | 0.3.1 | 404 | bootstrap |
| office | 0.1.4 | 0.1.3 | 404 | bootstrap (gates Phase 3 sub-wave C — R5/2 + R5/3 must also be on Rebel `dev` before this lands in any release window) |
| outreach | 0.1.3 | 0.1.2 | 404 | bootstrap |
| pandadoc | 0.2.2 | 0.2.1 | 404 | bootstrap |
| quickbooks | 0.3.1 | 0.2.1 | 404 | bootstrap (note: legacy is 0.2.1, local is 0.3.1 — minor-version delta, unusual but intentional per the connector's own changelog) |
| retell-ai | 0.2.1 | 0.2.0 | 404 | bootstrap |
| runway | 0.3.2 | 0.3.1 | 404 | bootstrap |
| salesforce | 0.1.2 | 0.1.1 | 404 | bootstrap |
| servicenow | 0.2.2 | 0.2.1 | 404 | bootstrap |
| slack | 0.1.2 | N/A (fresh) | exists @ 0.1.2 | DONE — version bumped from 0.1.1 to 0.1.2 to ship the fast-uri / hono / ip-address / express-rate-limit transitive security patches (PR #35) ahead of the inaugural `@mindstone/` publish. Verified end-to-end with `npm run probe:live:gate` (9/9 probes, p95 856 ms). |
| talentlms | 0.2.2 | 0.2.1 | 404 | bootstrap |
| workday | 0.2.2 | 0.2.1 | 404 | bootstrap |
| zendesk | 0.3.2 | 0.3.1 | 404 | bootstrap |

### Pre-flight verifications (all PASS as of 2026-05-17)

- Version sync: package.json ↔ package-lock.json (top + packages[""]) ↔ server.json (top + packages[0]) — zero drift across all 26 connectors.
- CHANGELOG.md present and contains `## [Unreleased]` section on every connector — required for the next post-bootstrap version.
- catalog-entry.json present on every connector (PR #31 backfill).
- Package name in package.json matches `@mindstone/mcp-server-<dir>` on every connector.
- All `prepublishOnly` scripts include audit + tarball guard (per audit recommendation R4, R14).

---

## Per-publish runbook (canonical)

Run this sequence once per connector. Replace `<connector>` and `<version>` from the table above.

```sh
CONNECTOR=fathom
NEW_VERSION=0.2.3
NEW_PACKAGE="@mindstone/mcp-server-$CONNECTOR"

# 1. Refresh main, confirm clean tree:
cd /path/to/mcp-servers
git checkout main && git pull --ff-only origin main
test -z "$(git status --porcelain)" || { echo "ABORT: dirty tree"; exit 1; }

# 2. Sanity-check the connector slice:
cd connectors/$CONNECTOR
jq -e --arg n "$NEW_PACKAGE" --arg v "$NEW_VERSION" '.name == $n and .version == $v' package.json \
  || { echo "ABORT: name/version mismatch"; exit 1; }

# 3. Build + test + audit + pack-scan locally (the `prepublishOnly` script already does most of this, but run them now so failures are loud, not hidden behind npm publish):
npm ci --ignore-scripts
npm run build
npm test
npm audit --omit=dev --audit-level=high
npm pack --dry-run --ignore-scripts | tee /tmp/pack-${CONNECTOR}.log
grep -E '\.map|\.test\.|__tests__|\.tgz|\.env|\.npmrc|\.ts$' /tmp/pack-${CONNECTOR}.log \
  && { echo "ABORT: forbidden file in tarball"; exit 1; } || echo "pack clean"

# 4. PUBLISH (this will trigger the WebAuthn 2FA prompt in the system browser):
npm publish --access=public --provenance=false
# --provenance=false because we are NOT publishing via GitHub Actions OIDC; the package
#  will publish without a provenance attestation. This is acceptable for manual mode.
#  If you want attestations later, switch to OIDC publishes (would re-introduce all the
#  G1/G4 work the manual-publish pivot deliberately deferred).

# 5. Confirm the publish landed:
sleep 5
npm view "$NEW_PACKAGE@$NEW_VERSION" version

# 6. Fire the catalog-sync dispatch to Rebel:
cd /path/to/mcp-servers
MAIN_SHA=$(git rev-parse origin/main)
gh api repos/mindstone/MindstoneRebel/dispatches \
  --method POST \
  -f event_type=connector-published \
  -F "client_payload[connector]=$CONNECTOR" \
  -F "client_payload[package]=$NEW_PACKAGE" \
  -F "client_payload[version]=$NEW_VERSION" \
  -F "client_payload[sha]=$MAIN_SHA"

# 7. Watch for Rebel workflow + PR (allow ~3 min):
sleep 60
gh run list --workflow=rebel-oss-catalog-sync.yml --repo mindstone/MindstoneRebel --limit 3 --json conclusion,headBranch,createdAt,displayTitle,url
gh pr list --repo mindstone/MindstoneRebel --head "catalog-sync/$CONNECTOR" --json number,title,url

# 8. Update the tracker (below).
```

---

## Publish tracker

Update this section as each publish + dispatch + Rebel-merge completes. State legend:
- `TODO` — not started
- `PUB` — published to npm
- `DSP` — dispatch fired to Rebel
- `PR-OPEN` — Rebel catalog-sync PR exists
- `MRG` — Rebel PR merged
- `DONE` — full cycle complete

```
                       | state    | npm@new       | rebel PR | merge SHA | notes
-----------------------+----------+---------------+----------+-----------+-----------------------------
apple-shortcuts        | DONE     | 0.1.2         | n/a      | n/a       | earlier wave burst
hubspot                | DONE     | 0.1.2         | n/a      | n/a       | earlier wave burst
browser-automation     | PUB      | 0.1.7         |          |           | published 2026-05-18 wave
elevenlabs             | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
email-imap             | PUB      | 0.2.3         |          |           | published 2026-05-18 wave
fathom                 | PUB      | 0.2.3         |          |           | published 2026-05-18 (was G6 smoke target)
freshdesk              | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
gamma                  | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
google-analytics       | PUB      | 0.1.1         |          |           | published 2026-05-18 wave
humaans                | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
kling                  | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
mixmax                 | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
nano-banana            | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
napkin                 | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
office                 | TODO     |               |          |           | held back — needs R5/2 + R5/3 on Rebel before publish
outreach               | PUB      | 0.1.3         |          |           | published 2026-05-18 wave
pandadoc               | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
quickbooks             | PUB      | 0.3.1         |          |           | published 2026-05-18 wave (intentional 0.2.1->0.3.1 minor delta, confirmed)
retell-ai              | PUB      | 0.2.1         |          |           | published 2026-05-18 wave
runway                 | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
salesforce             | PUB      | 0.1.2         |          |           | published 2026-05-18 wave
servicenow             | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
slack                  | PUB      | 0.1.2         |          |           | published 2026-05-19 — security patch sub-wave (PR #35 lockfile fix + PR #36 version bump); live-probe gate 9/9 green
talentlms              | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
workday                | PUB      | 0.2.2         |          |           | published 2026-05-18 wave
zendesk                | PUB      | 0.3.2         |          |           | published 2026-05-18 wave
```

Summary: **23/24 PUB** (slack inaugural-publish closed the security-patch sub-wave on 2026-05-19), **1/24 TODO** (office, gated on Rebel R5/2 + R5/3). All 23 `DSP/PR-OPEN/MRG` columns remain blank pending Rebel R7 merge — once R7 lands, fire 23 catalog-sync dispatches in one batch and watch the resulting PRs.

### Cool-down

`docs/PUBLISH_APPROVAL_PROCESS.md` calls for 24h cool-down between major sub-waves. Suggested cadence:
- Day 1 (smoke sub-wave): fathom + slack (low-risk: fathom is the chosen smoke target; slack is fresh-fresh and has no users yet)
- Day 2: 4-5 mid-tier connectors (no Rebel constants tied to them)
- Day 3+: remaining 17 in batches of 5, monitoring catalog-sync PRs for any unexpected diff

Office is held back until R5/2 + R5/3 are on Rebel `dev`.

---

## Rollback

If a publish goes out and the catalog-sync PR shows unexpected diff (R7 regression), or post-merge Rebel users report a regression:

```sh
# Within 24h of publish:
npm unpublish "$NEW_PACKAGE@$NEW_VERSION"

# Post-24h, can only deprecate:
npm deprecate "$NEW_PACKAGE@$NEW_VERSION" "Deprecated — see docs/EMERGENCY_REVOKE.md"
```

Then close the Rebel catalog-sync PR without merging. See `docs/EMERGENCY_REVOKE.md` for the full procedure.

---

## Open questions / follow-ups

1. **Second `@mindstone/` npm member**: add before Phase 3 to remove single-point-of-failure on the publisher account. Candidate: same person being added to `oss-maintainers` GitHub team.
2. **Provenance attestations**: currently `false` in manual mode. Reconsider after Phase 2 completes — running 24 publishes via OIDC would require all the G1/G4 work the pivot deferred. Decision deferred to post-wave retrospective.
3. ~~**quickbooks minor-version delta**~~: confirmed intentional with the committer on 2026-05-18; published at 0.3.1.
4. ~~**slack fresh-fresh**~~: confirmed — slack was never on legacy scope. Inaugural `@mindstone/` publish landed at 0.1.2 on 2026-05-19 (the 0.1.1 target was bumped to 0.1.2 to ship the transitive-dep security patches in the same artifact).

---

## G6 partial dry-run — fathom (2026-05-17)

Steps A-F of the per-publish runbook were executed locally against `connectors/fathom` at version 0.2.3 to validate the procedure ahead of the real Phase 2 bootstrap.

| Step | Outcome |
|---|---|
| A. package.json contract (name = `@mindstone/mcp-server-fathom`, version present, not private) | PASS |
| B. `npm ci --ignore-scripts` | PASS (0 vulnerabilities, 61 packages installed) |
| C. `npm run build` (`tsc && shx chmod +x dist/index.js`) | PASS |
| D. `npm test` (vitest) | PASS — 24/24 tests, 30.5s |
| E. `npm audit --omit=dev --audit-level=high` | PASS — 0 vulnerabilities |
| F. `npm pack --dry-run --ignore-scripts` + forbidden-file scan | PASS — 25 files in tarball, all under `dist/` + LICENSE + package.json + README.md; no `.map`, `.test.`, `__tests__`, raw `.ts` source, `.env*`, `.npmrc`, nested `.tgz` |

Tarball stats: package size 12.5 kB, unpacked 42.0 kB.

**Steps 4-7 (publish + dispatch + Rebel PR check) were NOT executed** because:
- Phase 0 Track 2 (Rebel R5/1 + R7) is still in progress.
- An actual publish at this point would burn version 0.2.3 on the new scope before R7 is merged — the resulting catalog-sync PR would have the broken-diff shape that R7 is meant to fix.

Re-run steps 4-7 on the real Phase 2 night, immediately after R7 merges on Rebel `dev`.

### Finding (non-blocking, follow-up)

Of the 26 connectors, only `hubspot` has a `prepublishOnly` script in `package.json` (running audit + tarball guard via `scripts/prepublish-check.sh`). The audit recommendation R4/R14 called for promoting this to the connector template so every package runs the same guards before `npm publish`. Track as a follow-up:

```
[follow-up] add prepublishOnly script (audit + pack-scan) to _template/ and the
25 connectors that don't have one. Non-blocking for Phase 2 since the manual
runbook runs the same checks; load-bearing if we ever revert to CI publishes.
```

---

## Sign-off

| Item | Verified by | When | Evidence |
|---|---|---|---|
| Audit clean (zero drift across all 26 connectors) | wave-lead | 2026-05-17 | `/tmp/audit-connectors.sh` output preserved in session |
| Legacy registry versions captured | wave-lead | 2026-05-17 | `/tmp/legacy-versions.sh` output above |
| npm scope state captured | wave-lead | 2026-05-17 | `npm org ls mindstone` |
| G6 partial dry-run on fathom (steps A-F) | wave-lead | 2026-05-17 | See "G6 partial dry-run" section above |
| Single-publisher risk acknowledged | __________ | _______ | __________ |
| Bootstrap plan reviewed by second human | __________ | _______ | __________ |
| Phase 0 Track 1 + Track 2 green | __________ | _______ | __________ |
| **Phase 2 unlocked** | __________ | _______ | __________ |
