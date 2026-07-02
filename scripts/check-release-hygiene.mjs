#!/usr/bin/env node
// Repo-wide release-hygiene gate (FOX-3594). Detects "committed but never shipped"
// classes: shared packages with src changes after the last version bump, and aging
// non-empty CHANGELOG [Unreleased] sections.
//
// Usage:
//   node scripts/check-release-hygiene.mjs
//   node scripts/check-release-hygiene.mjs --self-test
//
// Exits 0 when all FAIL-severity findings are absent or baselined; non-zero otherwise.
// WARN-severity findings (connector [Unreleased]) print but do not fail CI.
//
// Baseline: scripts/release-hygiene-baseline.json — per-package entries with ackCommits
// downgrade Detection A FAIL to ACK only when every post-bump src commit is listed.
// Detection B still ACKs on package presence. See untrusted-coverage-baseline.json.

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let repoRoot = resolve(__dirname, '..');

const baselinePath = join(__dirname, 'release-hygiene-baseline.json');
let baseline = {};
if (existsSync(baselinePath)) {
  const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const { $comment, ...entries } = raw;
  baseline = entries;
}

function sh(cmd, cwd = repoRoot) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function trySh(cmd, cwd = repoRoot) {
  try {
    return sh(cmd, cwd);
  } catch {
    return null;
  }
}

function listPkgDirs() {
  const out = [];
  for (const base of ['connectors', 'packages']) {
    const b = join(repoRoot, base);
    if (!existsSync(b)) continue;
    for (const name of readdirSync(b)) {
      if (base === 'connectors' && name === '_template') continue;
      const dir = join(base, name);
      const full = join(repoRoot, dir);
      if (existsSync(join(full, 'package.json')) && statSync(full).isDirectory()) {
        out.push(dir);
      }
    }
  }
  return out.sort();
}

function pkgKey(dir) {
  return dir.split('/').pop();
}

function lastVersionBumpSha(dir) {
  return trySh(`git log -1 --format=%h -G '"version"' -- ${dir}/package.json`);
}

function srcCommitsAfterBump(dir, bumpSha) {
  if (!bumpSha) return { shas: [], display: [] };
  const log = trySh(`git log ${bumpSha}..HEAD --format=%H%x09%s -- ${dir}/src`);
  if (!log) return { shas: [], display: [] };
  const shas = [];
  const display = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const sha = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : '';
    shas.push(sha);
    display.push(subject ? `${sha.slice(0, 7)} ${subject}` : sha.slice(0, 7));
  }
  return { shas, display };
}

function unreleasedBody(dir) {
  const cl = join(repoRoot, dir, 'CHANGELOG.md');
  if (!existsSync(cl)) return null;
  const txt = readFileSync(cl, 'utf8');
  const m = txt.match(/##\s*\[Unreleased\]([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (!m) return null;
  const stripped = m[1].replace(/^\s*###[^\n]*$/gm, '').replace(/[\s\-*]/g, '');
  return stripped.length > 0 ? m[1].trim() : null;
}

function newestSrcCommitDate(dir) {
  return trySh(`git log -1 --format=%cs -- ${dir}/src`);
}

function lastVersionBumpDate(dir) {
  const sha = lastVersionBumpSha(dir);
  if (!sha) return null;
  return trySh(`git log -1 --format=%cs ${sha}`);
}

function baselineEntry(key) {
  const entry = baseline[key];
  if (!entry) return null;
  if (typeof entry === 'string') return { reason: entry, ackCommits: [] };
  return entry;
}

function baselineReason(key) {
  return baselineEntry(key)?.reason ?? '';
}

/** Detection B: package-level ACK when a baseline entry exists. */
function isBaselinedForB(key) {
  return baselineEntry(key) != null;
}

/** Detection A: ACK only when every post-bump src commit SHA is in ackCommits. */
function isBaselinedForA(key, commitShas) {
  const entry = baselineEntry(key);
  if (!entry) return false;
  const ack = entry.ackCommits;
  if (!Array.isArray(ack) || ack.length === 0) return false;
  const ackSet = new Set(ack);
  return commitShas.length > 0 && commitShas.every((sha) => ackSet.has(sha));
}

// --- Detection A: shared packages with src commits after last version bump --------

function runDetectionA() {
  const findings = [];
  for (const dir of listPkgDirs().filter((d) => d.startsWith('packages/'))) {
    const key = pkgKey(dir);
    const bumpSha = lastVersionBumpSha(dir);
    const { shas, display } = srcCommitsAfterBump(dir, bumpSha);
    if (shas.length === 0) continue;
    const pkgVersion = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')).version;
    findings.push({
      severity: 'FAIL',
      detection: 'A',
      dir,
      key,
      message:
        `${dir}: src/ changed after last version bump (${bumpSha}, pkg@${pkgVersion}) — ` +
        `${shas.length} commit(s) never shipped`,
      detail: display,
      baselined: isBaselinedForA(key, shas),
      baselineReason: baselineReason(key),
    });
  }
  return findings;
}

// --- Detection B: non-empty [Unreleased] CHANGELOG --------------------------------

function runDetectionB() {
  const findings = [];
  for (const dir of listPkgDirs()) {
    const body = unreleasedBody(dir);
    if (!body) continue;
    const key = pkgKey(dir);
    const isPkg = dir.startsWith('packages/');
    const bump = lastVersionBumpDate(dir);
    const srcDate = newestSrcCommitDate(dir);
    findings.push({
      severity: isPkg ? 'FAIL' : 'WARN',
      detection: 'B',
      dir,
      key,
      message:
        `${dir}: non-empty CHANGELOG [Unreleased] (last version bump: ${bump ?? 'unknown'}, ` +
        `newest src commit: ${srcDate ?? 'none'})`,
      detail: body.split('\n').slice(0, 3),
      baselined: isPkg && isBaselinedForB(key),
      baselineReason: baselineReason(key),
    });
  }
  return findings;
}

function formatFinding(f) {
  const tag =
    f.baselined && f.severity === 'FAIL'
      ? 'ACK'
      : f.severity === 'FAIL'
        ? 'FAIL'
        : 'WARN';
  const baselineNote =
    f.baselined && f.severity === 'FAIL' ? ` (baselined: ${f.baselineReason})` : '';
  const lines = [`  [${tag}] [${f.detection}] ${f.message}${baselineNote}`];
  if (f.detail?.length) {
    for (const line of f.detail.slice(0, 10)) {
      lines.push(`         ${line}`);
    }
    if (f.detail.length > 10) {
      lines.push(`         ... and ${f.detail.length - 10} more`);
    }
  }
  return lines.join('\n');
}

function evaluate(findings) {
  let failCount = 0;
  let warnCount = 0;
  let ackCount = 0;

  const aFindings = findings.filter((f) => f.detection === 'A');
  const bFindings = findings.filter((f) => f.detection === 'B');

  console.log('=== Detection A: shared packages with src commits after last version bump ===');
  if (aFindings.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of aFindings) {
      console.log(formatFinding(f));
      if (f.severity === 'FAIL') {
        if (f.baselined) ackCount += 1;
        else failCount += 1;
      }
    }
  }
  console.log(`  -> ${aFindings.length} shared package(s) flagged\n`);

  console.log('=== Detection B: non-empty CHANGELOG [Unreleased] ===');
  if (bFindings.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of bFindings) {
      console.log(formatFinding(f));
      if (f.severity === 'FAIL') {
        if (f.baselined) ackCount += 1;
        else failCount += 1;
      } else {
        warnCount += 1;
      }
    }
  }
  console.log(`  -> ${bFindings.length} package(s) with unshipped [Unreleased] content\n`);

  console.log('=== release-hygiene summary ===');
  console.log(
    `FAIL: ${failCount} unbaselined | ACK: ${ackCount} baselined | WARN: ${warnCount} (connectors only)`,
  );

  return failCount;
}

// --- Self-test --------------------------------------------------------------------

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'release-hygiene-selftest-'));
  const prevRoot = repoRoot;
  const prevBaseline = baseline;
  repoRoot = tmp;
  baseline = {};

  const legs = [];

  function leg(label, fn, expectFailCount) {
    const got = fn();
    const pass = got === expectFailCount;
    legs.push({ label, expectFailCount, got, pass });
    console.log(
      `  ${pass ? 'PASS' : 'FAIL'} — ${label} (expected ${expectFailCount} unbaselined FAIL(s), got ${got})`,
    );
  }

  try {
    console.log('check-release-hygiene: self-test (synthetic git fixtures)');

    sh('git init -b main');
    sh('git config user.email selftest@example.com');
    sh('git config user.name selftest');

    const pkgDir = 'packages/test-shared';
    mkdirSync(join(tmp, pkgDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmp, pkgDir, 'package.json'),
      JSON.stringify({ name: '@mindstone/test-shared', version: '1.0.0' }, null, 2) + '\n',
    );
    writeFileSync(join(tmp, pkgDir, 'CHANGELOG.md'), '## [Unreleased]\n\n');
    writeFileSync(join(tmp, pkgDir, 'src', 'index.ts'), 'export const v = 1;\n');
    sh('git add -A && git commit -m "chore(test-shared): initial 1.0.0"');

    // Detection A leg 1: src change without version bump must FAIL.
    writeFileSync(join(tmp, pkgDir, 'src', 'index.ts'), 'export const v = 2;\n');
    sh('git add -A && git commit -m "feat(test-shared): functional src change"');
    leg('Detection A flags post-bump src commits (init only)', () => evaluate(runDetectionA()), 1);

    // Detection A leg 2: semver VALUE bump then src — pickaxe must resolve bump commit, not init.
    writeFileSync(
      join(tmp, pkgDir, 'package.json'),
      JSON.stringify({ name: '@mindstone/test-shared', version: '1.0.1' }, null, 2) + '\n',
    );
    sh('git add -A && git commit -m "chore(test-shared): bump to 1.0.1"');
    writeFileSync(join(tmp, pkgDir, 'src', 'index.ts'), 'export const v = 3;\n');
    sh('git add -A && git commit -m "feat(test-shared): post-bump src change"');
    leg('Detection A flags src after semver value bump', () => evaluate(runDetectionA()), 1);

    // Detection A leg 3: ackCommits baseline must not mask unlisted post-bump commits.
    baseline = {
      'test-shared': {
        reason: 'self-test: only the bump commit is acked',
        ackCommits: [sh('git rev-parse HEAD~1')],
      },
    };
    leg(
      'Detection A unlisted post-bump commit fails despite partial ackCommits',
      () => evaluate(runDetectionA()),
      1,
    );
    baseline = {};

    // Detection B: promote [Unreleased] content must FAIL for packages.
    writeFileSync(
      join(tmp, pkgDir, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Added\n\n- pending feature\n\n## [1.0.0] - 2026-01-01\n',
    );
    sh('git add -A && git commit -m "docs(test-shared): unreleased changelog note"');
    leg('Detection B flags non-empty [Unreleased] on packages', () => evaluate(runDetectionB()), 1);

    // Empty package [Unreleased] so the connector-only leg is isolated.
    writeFileSync(join(tmp, pkgDir, 'CHANGELOG.md'), '## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n');
    sh('git add -A && git commit -m "docs(test-shared): clear unreleased"');

    // Connector [Unreleased] is WARN-only (no unbaselined FAIL).
    const connDir = 'connectors/test-connector';
    mkdirSync(join(tmp, connDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmp, connDir, 'package.json'),
      JSON.stringify({ name: '@mindstone/mcp-server-test-connector', version: '0.1.0' }, null, 2) +
        '\n',
    );
    writeFileSync(
      join(tmp, connDir, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Changed\n\n- docs only\n',
    );
    writeFileSync(join(tmp, connDir, 'src', 'index.ts'), 'export {};\n');
    sh('git add -A && git commit -m "docs(test-connector): unreleased note"');
    leg('Detection B connector [Unreleased] is WARN-only', () => evaluate(runDetectionB()), 0);

    const failures = legs.filter((l) => !l.pass);
    if (failures.length > 0) {
      console.error(`\ncheck-release-hygiene: SELF-TEST FAILED (${failures.length}/${legs.length} legs)`);
      return 1;
    }
    console.log(`\ncheck-release-hygiene: self-test PASS (${legs.length}/${legs.length} legs)`);
    return 0;
  } finally {
    repoRoot = prevRoot;
    baseline = prevBaseline;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Main -------------------------------------------------------------------------

const arg = process.argv[2];
if (arg === '--self-test') {
  process.exit(runSelfTest());
}
if (arg === '--help' || arg === '-h') {
  console.log(`Usage:
  node scripts/check-release-hygiene.mjs
  node scripts/check-release-hygiene.mjs --self-test`);
  process.exit(0);
}
if (arg) {
  console.error(`check-release-hygiene: unknown argument "${arg}"`);
  console.error('usage: node scripts/check-release-hygiene.mjs [--self-test]');
  process.exit(2);
}

const findings = [...runDetectionA(), ...runDetectionB()];
const failCount = evaluate(findings);
if (failCount > 0) {
  console.error(`\ncheck-release-hygiene: FAILED (${failCount} unbaselined finding(s))`);
  process.exit(1);
}
console.log('\ncheck-release-hygiene: PASS');
process.exit(0);
