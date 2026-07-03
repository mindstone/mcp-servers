#!/usr/bin/env node
// Bump every committed version surface for ONE connector, in lockstep, then
// regenerate the committed derived artifacts. This is the single bump
// implementation: the Mindstone Rebel release tooling (scripts/mcp-release.ts
// Stage 1 in the Rebel repo) shells out to it, and the first-publish
// bootstrap recipe in CONTRIBUTING.md invokes it by hand. It mutates files
// only — it NEVER commits; commit authorship (and the Release-Gate trailer)
// stays with the caller.
//
// Usage:
//   node scripts/bump-connector.mjs <connector> --to <version> \
//     --changelog-entry "<one-line release note>" [--date YYYY-MM-DD]
//
// Surfaces written on a bump (current version < --to):
//   connectors/<name>/package.json        version
//   connectors/<name>/package-lock.json   regenerated via `npm install --package-lock-only`
//   connectors/<name>/server.json         version + packages[0].version
//   connectors/<name>/CHANGELOG.md        `## [<version>] - <date>` block inserted under
//                                         `## [Unreleased]` (an empty Unreleased block is re-inserted)
//   docs/index.md, docs/catalogue/<name>.md, README install-links blocks
//                                         regenerated via the existing generator scripts
//
// STATUS.json is deliberately NOT touched: schema v2 stores no version
// (it is derived from package.json — scripts/check-status.mjs rejects a
// present field; see docs/plans/260609_catalogue_drift_prevention.md).
//
// Idempotent sync mode (current version == --to): the bump writes are
// skipped, but ONLY after validating that every other lockstep version
// surface (package-lock.json, server.json, CHANGELOG.md) already sits at
// --to — a partial state is a desynced externally-landed bump and fails
// closed (route: manual runbook). When the validation passes, the
// generators still run (write-on-drift), so a resumed or fully-landed
// bump self-heals. A --to BEHIND the current
// version also fails closed.
//
// Precondition (both modes, before any write): server.json is validated via
// scripts/check-server-json.mjs — the same pinned `mcp-publisher validate`
// (registry round-trip) the "server.json check" CI workflow runs. Fails
// closed offline; see that script's header for the policy.
//
// Version-skew note: Rebel's mcp-release.ts executes whatever copy of this
// script its submodule pin has — a Rebel-side change that assumes a newer
// flag here must land in mcp-servers (and the pin advance) first.
// mcp-release.ts fails loud if this script is absent at the pin.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const USAGE = `Usage:
  node scripts/bump-connector.mjs <connector> --to <version> --changelog-entry "<text>" [--date YYYY-MM-DD]

Bumps every committed version surface for one connector in lockstep
(package.json, package-lock.json, server.json, CHANGELOG.md), then
regenerates the committed catalogue + install-links artifacts. STATUS.json
carries no version (schema v2) and is not touched. Mutates files only —
never commits. If the connector is already at --to, validates that every
other lockstep surface is also at --to (fail closed on any stale surface),
then runs the idempotent sync (generators) only. In both modes, server.json
is first validated against the MCP registry via scripts/check-server-json.mjs
(fail closed, including when offline — registry rules are server-side only).

Flags:
  --to <x.y.z>             target version; must not be behind the current version
  --changelog-entry "..."  one-line release note (<= 200 chars) for the new
                           CHANGELOG block; required when actually bumping
  --date YYYY-MM-DD        CHANGELOG release date (default: today, UTC)
  --base-dir connectors|packages
                           package family directory (default: connectors)
  --skip-server-json-check skip the registry validation precondition.
                           HERMETIC-TEST ESCAPE ONLY — real bumps must not
                           pass it (CI re-validates regardless)
  --help                   print this usage`;

function fail(msg) {
  console.error(`bump-connector: ${msg}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// Keep README ## Status **Version:** / **Tools:** in lockstep with package.json and
// STATUS.json so the Status block cannot drift after a release bump.
function updateReadmeStatusBlock(connectorDir, version, toolsCount) {
  const readmePath = join(connectorDir, 'README.md');
  if (!existsSync(readmePath)) return false;

  const readme = readFileSync(readmePath, 'utf8');
  const blockRe = /(^##\s+Status\s*$\n[\s\S]*?)(?=\n##\s|$)/m;
  const match = readme.match(blockRe);
  if (!match) return false;

  let block = match[1];
  const versionRe = /(\*\*Version:\*\*\s*)\[(\d+\.\d+\.\d+)\]/;
  const toolsRe = /(\*\*Tools:\*\*\s*)\[(\d+)\]/;
  if (!versionRe.test(block)) return false;

  block = block.replace(versionRe, `$1[${version}]`);
  if (toolsCount != null && toolsRe.test(block)) {
    block = block.replace(toolsRe, `$1[${toolsCount}]`);
  }

  writeFileSync(readmePath, readme.replace(blockRe, () => block));
  return true;
}

// Strict x.y.z only. Every committed version surface in this repo is plain
// semver; a prerelease/build suffix would desync the Rebel catalog pins and
// the release workflow's detect job, so reject it up front.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Numeric major.minor.patch comparison: negative if a < b, 0 if equal,
// positive if a > b. (Same ordering the Rebel release tooling uses for its
// ahead-of-pin checks.)
function compareSemver(a, b) {
  const parse = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) fail(`cannot compare non-semver version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// --- Argument parsing (fail closed: no args -> usage + exit 1) --------------

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      to: { type: 'string' },
      'changelog-entry': { type: 'string' },
      date: { type: 'string' },
      'base-dir': { type: 'string', default: 'connectors' },
      'skip-server-json-check': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
const { values, positionals } = parsed;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const connector = positionals[0];
if (!connector || positionals.length > 1) {
  fail(`expected exactly one <connector> argument\n\n${USAGE}`);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(connector)) {
  fail(`connector name must be a lowercase slug (got "${connector}")`);
}

const toVersion = values.to;
if (!toVersion) {
  fail(`missing --to <version>\n\n${USAGE}`);
}
if (!SEMVER_RE.test(toVersion)) {
  fail(`--to must be plain x.y.z semver (got "${toVersion}")`);
}

let releaseDate = values.date;
if (releaseDate !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || Number.isNaN(Date.parse(`${releaseDate}T00:00:00Z`))) {
    fail(`--date must be a valid YYYY-MM-DD date (got "${releaseDate}")`);
  }
} else {
  releaseDate = new Date().toISOString().slice(0, 10);
}

const baseDir = values['base-dir'];
if (baseDir !== 'connectors' && baseDir !== 'packages') {
  fail(`--base-dir must be "connectors" or "packages" (got "${baseDir}")\n\n${USAGE}`);
}

// --- Preconditions -----------------------------------------------------------

const connectorDir = join(repoRoot, baseDir, connector);
if (!existsSync(connectorDir)) {
  fail(`connector directory not found: ${connectorDir}`);
}

const pkgJsonPath = join(connectorDir, 'package.json');
if (!existsSync(pkgJsonPath)) {
  fail(`missing package.json at ${pkgJsonPath}`);
}
const pkgJson = readJson(pkgJsonPath);
const currentVersion = pkgJson.version;
if (typeof currentVersion !== 'string' || !SEMVER_RE.test(currentVersion)) {
  fail(`current package.json version is not plain x.y.z semver (got "${currentVersion}")`);
}

const cmp = compareSemver(toVersion, currentVersion);
if (cmp < 0) {
  fail(
    `--to ${toVersion} is BEHIND the current version ${currentVersion} of "${connector}". ` +
      `Version bumps only move forward; rolling back a bad bump is a git revert of the bump ` +
      `commit, not a re-bump to an older version.`,
  );
}
const syncOnly = cmp === 0;

const changelogEntry = values['changelog-entry'];
if (!syncOnly) {
  // A bump must carry a one-line CHANGELOG note; long-form notes belong in
  // CHANGELOG.md itself (same contract as the Rebel release tooling's
  // --description flag).
  if (!changelogEntry || changelogEntry.trim().length === 0) {
    fail(`missing --changelog-entry "<text>" — every version bump adds a CHANGELOG note\n\n${USAGE}`);
  }
  if (changelogEntry.length > 200) {
    fail(`--changelog-entry must be <= 200 chars (got ${changelogEntry.length}); long-form notes belong in CHANGELOG.md`);
  }
}

// --- CHANGELOG preconditions (checked BEFORE any write, so a refused bump
//     leaves the tree untouched) -----------------------------------------------
//
// AGENTS.md requires a Keep-a-Changelog entry for every version bump and CI
// rejects drift, so fail closed on a missing file, a missing `## [Unreleased]`
// header, or a pre-existing block for the target version (surfaces desynced).

const changelogPath = join(connectorDir, 'CHANGELOG.md');
if (!syncOnly) {
  if (!existsSync(changelogPath)) {
    fail(
      `connector "${connector}" has no CHANGELOG.md at ${changelogPath}. ` +
        `AGENTS.md requires every version bump to add a Keep-a-Changelog entry. ` +
        `Create the file with at least an "## [Unreleased]" section, then re-run.`,
    );
  }
  const changelog = readFileSync(changelogPath, 'utf8');
  if (!/^## \[Unreleased\]\s*\n/m.test(changelog)) {
    fail(
      `${changelogPath} has no "## [Unreleased]" header. ` +
        `AGENTS.md requires this section for the changelog insertion. Add it, then re-run.`,
    );
  }
  if (changelog.includes(`## [${toVersion}]`)) {
    fail(
      `${changelogPath} already contains a "## [${toVersion}]" block but package.json is at ` +
        `${currentVersion} — the version surfaces are desynced. Reconcile the CHANGELOG by hand, then re-run.`,
    );
  }
}

// --- server.json registry precondition (fail closed BEFORE any write) ---------
//
// The MCP registry enforces rules server-side that the static JSON schema
// does not (e.g. description length <= 100 — the 260611 canary incident).
// scripts/check-server-json.mjs runs the same pinned `mcp-publisher
// validate` (schema + registry round-trip) as the "server.json check" CI
// workflow, so a bump never commits to writes on top of a server.json the
// registry would reject. It validates the CURRENT content — the bump itself
// only rewrites the two version fields, and CI re-validates the final state.
// No network => the check fails closed (exit 2), never skip-passes.

{
  const serverJsonPath = join(connectorDir, 'server.json');
  // --skip-server-json-check: HERMETIC-TEST ESCAPE ONLY (fixture skeletons have
  // no registry access and no scripts/ tree). Every real path — mcp:release,
  // the bootstrap recipe — runs the precondition; CI re-validates regardless.
  const skipServerJsonCheck = values['skip-server-json-check'];
  if (skipServerJsonCheck) {
    console.warn('bump-connector: WARNING — server.json registry validation SKIPPED (--skip-server-json-check; hermetic-test escape, CI still validates)');
  }
  if (!skipServerJsonCheck && existsSync(serverJsonPath)) {
    console.log(`bump-connector: validating server.json against the MCP registry (scripts/check-server-json.mjs ${connector})`);
    const r = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'check-server-json.mjs'), connector],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    if (r.status !== 0) {
      fail(
        r.status === 2
          ? `server.json registry validation could not run (offline or unsupported environment) — ` +
              `failing closed before any write. Re-run with network access, or land the change via PR ` +
              `so the "server.json check" CI gate validates it pre-merge (manual path: ` +
              `MCP_OSS_PACKAGE_MANUAL_UPDATE.md in the Rebel repo's docs/project/).`
          : `connectors/${connector}/server.json failed registry validation (see errors above) — ` +
              `fix it before bumping. No version surfaces were written.`,
      );
    }
  }
}

// --- Lockstep bump -------------------------------------------------------------

const changed = [];

if (syncOnly) {
  // Sync mode is only legal when EVERY lockstep version surface already sits
  // at --to. package.json alone matching is NOT proof the bump landed: an
  // externally-landed bump can leave package-lock.json, server.json, or the
  // CHANGELOG stale, and skipping the bump writes here would let that
  // desynced state proceed as if it were lockstep. Validate every surface
  // BEFORE any write (fail closed leaves the tree untouched) and route the
  // stale states to the manual runbook — they need human reconciliation,
  // not a resumed sync.
  const staleSurfaces = [];

  const lockPath = join(connectorDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    if (lock.version !== toVersion) {
      staleSurfaces.push(`package-lock.json version is "${lock.version}" (expected ${toVersion})`);
    }
    const lockRootPkg = lock.packages?.[''];
    if (lockRootPkg && lockRootPkg.version !== toVersion) {
      staleSurfaces.push(
        `package-lock.json packages[""].version is "${lockRootPkg.version}" (expected ${toVersion})`,
      );
    }
  }

  const serverJsonPath = join(connectorDir, 'server.json');
  if (existsSync(serverJsonPath)) {
    const serverJson = readJson(serverJsonPath);
    if (serverJson.version !== toVersion) {
      staleSurfaces.push(`server.json version is "${serverJson.version}" (expected ${toVersion})`);
    }
    const firstPkg = Array.isArray(serverJson.packages) ? serverJson.packages[0] : undefined;
    if (firstPkg && firstPkg.version !== toVersion) {
      staleSurfaces.push(
        `server.json packages[0].version is "${firstPkg.version}" (expected ${toVersion})`,
      );
    }
  }

  if (!existsSync(changelogPath)) {
    staleSurfaces.push(`CHANGELOG.md is missing (expected a "## [${toVersion}]" block)`);
  } else if (!readFileSync(changelogPath, 'utf8').includes(`## [${toVersion}]`)) {
    staleSurfaces.push(`CHANGELOG.md has no "## [${toVersion}]" block`);
  }

  if (staleSurfaces.length > 0) {
    fail(
      `connector "${connector}" package.json is already at ${toVersion}, but other lockstep ` +
        `version surfaces are stale:\n` +
        staleSurfaces.map((s) => `  - ${s}`).join('\n') +
        `\nThis is a desynced externally-landed bump, not a resumable sync — automated ` +
        `reconciliation must refuse it. Reconcile the stale surface(s) by hand via the manual ` +
        `runbook (MCP_OSS_PACKAGE_MANUAL_UPDATE.md in the Rebel repo's docs/project/), then re-run.`,
    );
  }

  console.log(
    `bump-connector: ${connector} already at ${toVersion}; running idempotent sync only ` +
      `(generated artifacts)`,
  );
  if (changelogEntry) {
    console.log('bump-connector: note — --changelog-entry is unused in sync mode (no new CHANGELOG block)');
  }
} else {
  console.log(`bump-connector: ${connector} ${currentVersion} -> ${toVersion}`);

  // 1. package.json — top-level version.
  pkgJson.version = toVersion;
  writeJson(pkgJsonPath, pkgJson);
  changed.push('package.json');

  // 2. package-lock.json — top-level + packages[""].version must bump in
  //    lockstep (CI enforces this invariant). Cheapest correct approach:
  //    let npm regenerate the lockfile from the edited package.json.
  const lockPath = join(connectorDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    console.log('bump-connector: regenerating package-lock.json (npm install --package-lock-only)');
    const r = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd: connectorDir,
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      fail('npm install --package-lock-only failed; cannot sync package-lock.json');
    }
    changed.push('package-lock.json');
  }

  // 3. server.json — top-level version + packages[0].version.
  const serverJsonPath = join(connectorDir, 'server.json');
  if (existsSync(serverJsonPath)) {
    const serverJson = readJson(serverJsonPath);
    serverJson.version = toVersion;
    if (Array.isArray(serverJson.packages) && serverJson.packages[0]) {
      serverJson.packages[0].version = toVersion;
    }
    writeJson(serverJsonPath, serverJson);
    changed.push('server.json');
  }

  // 4. CHANGELOG.md — insert a `## [<version>] - YYYY-MM-DD` block under the
  //    existing `## [Unreleased]` line (Keep-a-Changelog convention),
  //    re-inserting an empty `## [Unreleased]` above. Preconditions were
  //    fail-closed-checked before any write, above.
  const existing = readFileSync(changelogPath, 'utf8');
  const newEntry = `## [Unreleased]\n\n## [${toVersion}] - ${releaseDate}\n\n### Changed\n\n- ${changelogEntry}\n\n`;
  writeFileSync(changelogPath, existing.replace(/^## \[Unreleased\]\s*\n/m, newEntry));
  changed.push('CHANGELOG.md');
}

// (STATUS.json: intentionally no step. Schema v2 stores no version — it is
// derived from package.json, and scripts/check-status.mjs rejects a present
// field — so there is nothing to sync. See the header note.)

// 5+6. Generated artifacts — docs/index.md + docs/catalogue/<name>.md are
//    built from every connector's STATUS.json, and the README install-links
//    block from server.json. Both generators are idempotent (write only on
//    drift); regenerate so the bump is self-cleaning and CI's drift checks
//    stay green.
function regen(scriptName) {
  const scriptPath = join(repoRoot, 'scripts', scriptName);
  if (!existsSync(scriptPath)) return;
  console.log(`bump-connector: regenerating via scripts/${scriptName}`);
  const r = spawnSync('node', [scriptPath], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    fail(`scripts/${scriptName} failed; cannot regenerate committed artifacts`);
  }
}
if (baseDir !== 'packages') {
  regen('build-catalogue.mjs');
  regen('gen-install-links.mjs');
}

// 7. README ## Status block — version + tools count (derived from STATUS.json).
const statusJsonPath = join(connectorDir, 'STATUS.json');
let toolsCount;
if (existsSync(statusJsonPath)) {
  const statusJson = readJson(statusJsonPath);
  toolsCount = statusJson.tools?.count;
}
if (updateReadmeStatusBlock(connectorDir, toVersion, toolsCount)) {
  changed.push('README.md (Status block)');
}

const generatorNote =
  baseDir === 'packages' ? '' : '; generators ran write-on-drift';
console.log(
  `bump-connector: done — ${connector}@${toVersion}` +
    (changed.length > 0 ? ` (wrote: ${changed.join(', ')}` : ' (no bump surfaces written') +
    `${generatorNote})`,
);
