#!/usr/bin/env node
// Local pre-land mirror of the "server.json check" CI workflow
// (.github/workflows/server-json-check.yml). Run it before pushing any
// change that touches a connector's server.json.
//
// Why this exists: the MCP registry enforces rules SERVER-SIDE that the
// static JSON schema does not — `mcp-publisher validate` POSTs the manifest
// to https://registry.modelcontextprotocol.io/v0/validate, and that round
// trip is the only pre-land detector for rules like "description length
// <= 100". A schema-only check false-passes them. (260611 incident: a
// 134-char canary description passed every local surface and turned main
// red post-land — see the Rebel repo's docs-private postmortem
// 260611_canary_serverjson_registry_description_ci_red.)
//
// Usage:
//   node scripts/check-server-json.mjs <connector> [<connector>...]
//   node scripts/check-server-json.mjs --all
//   node scripts/check-server-json.mjs --self-test
//
// What it runs per connector (same checks, same order as CI):
//   1. server.json <-> package.json mcpName drift detection
//   2. cross-file consistency (name/mcpName, version lockstep, identifier)
//   3. pinned `mcp-publisher validate` — schema + registry round-trip
//
// Network policy: FAIL CLOSED. If the registry round-trip cannot be
// exercised (offline, proxy, DNS), this script exits 2 with an OFFLINE
// error — it NEVER skip-passes, because the rules that matter most live
// only on the registry's side. When offline, land the change via PR so the
// "server.json check" CI gate validates it, or follow the manual runbook
// (MCP_OSS_PACKAGE_MANUAL_UPDATE.md in the Rebel repo's docs/project/).
//
// Binary acquisition mirrors CI exactly: same VERSION, sha256-pinned
// per-platform tarballs, cached under .cache/ (gitignored). Bumping
// PUBLISHER_VERSION requires recomputing ALL tarball hashes in the same
// commit AND keeping linux_amd64 identical to EXPECTED_SHA256 in
// .github/workflows/server-json-check.yml.
//
// Exit codes: 0 = all pass, 1 = validation failure, 2 = fail-closed
// environment failure (offline, unsupported platform, bad download).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const USAGE = `Usage:
  node scripts/check-server-json.mjs <connector> [<connector>...]
  node scripts/check-server-json.mjs --all
  node scripts/check-server-json.mjs --self-test

Validates connectors/<name>/server.json the same way the "server.json
check" CI workflow does: drift + cross-file consistency checks, then the
pinned \`mcp-publisher validate\` (which round-trips the manifest to the
MCP registry — the only place rules like description length <= 100 are
enforced). Fails closed (exit 2) if the registry is unreachable; it never
skip-passes. --self-test replays the 260611 incident description and
asserts it is rejected.`;

// Keep VERSION + linux_amd64 hash in lockstep with
// .github/workflows/server-json-check.yml (EXPECTED_SHA256). All four
// hashes computed from the GitHub release assets at pin time (2026-06-11):
//   curl -fsSL <url> | shasum -a 256
const PUBLISHER_VERSION = 'v1.7.7';
const TARBALL_SHA256 = {
  linux_amd64: 'a7aeba18c00caeae509d1dd74494b0a260a4245bcc65b25b8284ad709fa71676', // == CI's EXPECTED_SHA256
  linux_arm64: 'c770a72667bcfb6f51c26e18928db7b36d76af0a2ba502e526df47da3b2e10e6',
  darwin_amd64: '4950fbb6119454ee9e43ae96e2c0fc9e04c8d41104e52bd4546cb1ce9b6b1795',
  darwin_arm64: '72ce2b18c666784fcb97b8bb7cdeba420d4cffe0743475a867d6b1caba1263e3',
};

// The literal description from mcp-servers commit 7a22cca (the 260611
// incident): 134 chars incl. an em-dash. The registry's server-side limit
// is <= 100; the static schema does NOT contain it, so a schema-only
// validate false-passes this string. --self-test asserts it is REJECTED —
// if it ever passes, the registry round-trip is no longer being exercised.
const INCIDENT_DESCRIPTION =
  "Mindstone's internal release-pipeline test connector — not for use. " +
  "Validates Rebel's OSS release pipeline. Single ping tool; no auth.";

// Failure-output patterns that mean "the registry could not be reached"
// (as opposed to "the registry rejected the manifest"). Derived from Go
// net/http error strings emitted by mcp-publisher.
const NETWORK_ERROR_RE =
  /error sending request|dial tcp|no such host|connection refused|connection reset|i\/o timeout|proxyconnect|TLS handshake|network is unreachable|temporary failure in name resolution/i;

const OFFLINE_GUIDANCE =
  'The registry round-trip (POST https://registry.modelcontextprotocol.io/v0/validate) could not be ' +
  'exercised, and registry rules (e.g. description length <= 100) are enforced server-side ONLY — so this ' +
  'check FAILS CLOSED rather than skip-passing. Re-run with network access, or land the server.json change ' +
  'via PR so the "server.json check" CI gate validates it pre-merge (manual path: ' +
  "MCP_OSS_PACKAGE_MANUAL_UPDATE.md in the Rebel repo's docs/project/).";

function failClosed(msg) {
  console.error(`check-server-json: OFFLINE/ENVIRONMENT FAILURE (fail closed)\n${msg}\n\n${OFFLINE_GUIDANCE}`);
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- Pinned mcp-publisher acquisition (mirrors the CI install step) ---------

function platformKey() {
  const os = { darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) {
    failClosed(
      `unsupported platform ${process.platform}/${process.arch} — no pinned mcp-publisher binary. ` +
        'Run on macOS/Linux, or land the change via PR and let CI validate it.',
    );
  }
  return `${os}_${arch}`;
}

async function ensurePublisher() {
  const key = platformKey();
  const expectedSha = TARBALL_SHA256[key];
  const cacheDir = join(repoRoot, '.cache', 'mcp-publisher', `${PUBLISHER_VERSION}_${key}`);
  const binPath = join(cacheDir, 'mcp-publisher');

  if (!existsSync(binPath)) {
    const url = `https://github.com/modelcontextprotocol/registry/releases/download/${PUBLISHER_VERSION}/mcp-publisher_${key}.tar.gz`;
    console.log(`check-server-json: downloading pinned mcp-publisher ${PUBLISHER_VERSION} (${key})`);
    let body;
    try {
      const res = await fetch(url);
      if (!res.ok) failClosed(`download failed: HTTP ${res.status} for ${url}`);
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      failClosed(`download failed for ${url}: ${err?.cause?.message ?? err.message}`);
    }
    const actualSha = createHash('sha256').update(body).digest('hex');
    if (actualSha !== expectedSha) {
      // Hash mismatch is a supply-chain red flag, not an offline condition —
      // but it still must never pass. Same fail-closed exit.
      failClosed(
        `sha256 mismatch for ${url}\n  expected ${expectedSha}\n  actual   ${actualSha}\n` +
          'Refusing to install. If upstream re-released the tag, re-audit and re-pin (CI workflow too).',
      );
    }
    mkdirSync(cacheDir, { recursive: true });
    const tgzPath = join(cacheDir, 'mcp-publisher.tgz');
    writeFileSync(tgzPath, body);
    const tar = spawnSync('tar', ['-xzf', tgzPath], { cwd: cacheDir, stdio: 'inherit' });
    if (tar.status !== 0) failClosed('tar extraction failed');
    rmSync(tgzPath);
    chmodSync(binPath, 0o755);
  }

  const ver = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
  const verOut = `${ver.stdout ?? ''}${ver.stderr ?? ''}`;
  if (ver.status !== 0 || !verOut.includes(PUBLISHER_VERSION.replace(/^v/, ''))) {
    failClosed(
      `cached mcp-publisher at ${binPath} is not runnable or not ${PUBLISHER_VERSION} ` +
        `(got: ${verOut.trim() || `exit ${ver.status}`}). Delete ${cacheDir} and re-run.`,
    );
  }
  return binPath;
}

// --- Per-connector check (same checks, same order as the CI workflow) -------

function runValidate(binPath, serverJsonPath, extraEnv = {}) {
  const r = spawnSync(binPath, ['validate', serverJsonPath], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** @returns {{ verdict: 'PASS' | 'SKIP', detail?: string }} — throws on failure */
function checkConnector(binPath, name) {
  const dir = join(repoRoot, 'connectors', name);
  const sj = join(dir, 'server.json');
  const pj = join(dir, 'package.json');
  if (!existsSync(dir)) throw new Error(`connector directory not found: ${dir}`);

  const hasSj = existsSync(sj);
  const pkg = existsSync(pj) ? readJson(pj) : {};
  const hasMcpName = typeof pkg.mcpName === 'string' && pkg.mcpName.length > 0;

  // Drift detection — both files must opt in together (mirrors CI).
  if (hasSj && !hasMcpName) throw new Error(`${name}: server.json present but mcpName missing in package.json (registry needs both)`);
  if (!hasSj && hasMcpName) throw new Error(`${name}: mcpName declared in package.json but server.json missing`);
  if (!hasSj) return { verdict: 'SKIP', detail: 'not yet onboarded to registry' };

  // Cross-file consistency — checks the publisher CLI does NOT do (mirrors CI).
  const server = readJson(sj);
  const problems = [];
  if (server.name !== pkg.mcpName) problems.push(`name (${server.name}) does not match package.json mcpName (${pkg.mcpName})`);
  if (server.version !== pkg.version) problems.push(`version (${server.version}) does not match package.json version (${pkg.version})`);
  if (server.version !== server.packages?.[0]?.version) problems.push(`version (${server.version}) does not match packages[0].version (${server.packages?.[0]?.version})`);
  if (server.packages?.[0]?.identifier !== pkg.name) problems.push(`packages[0].identifier (${server.packages?.[0]?.identifier}) does not match package.json name (${pkg.name})`);
  if (problems.length > 0) throw new Error(`${name}: ${problems.join('; ')}`);

  // Authoritative schema + registry round-trip check.
  const { status, output } = runValidate(binPath, sj);
  if (status !== 0) {
    if (NETWORK_ERROR_RE.test(output)) failClosed(`registry unreachable while validating ${name}:\n${output.trim()}`);
    throw new Error(`${name}: mcp-publisher validate failed\n${output.trim()}`);
  }
  return { verdict: 'PASS' };
}

// --- Self-test: replay the 260611 incident ----------------------------------
//
// Three legs, all mandatory:
//   1. positive control — canary's committed server.json passes (proves the
//      harness + round-trip work; canary is the designated pipeline-test
//      connector and must always be registry-valid at HEAD)
//   2. incident replay — the literal 134-char em-dash description MUST be
//      rejected by the registry round-trip; if it passes, the check has
//      regressed to schema-only validation and would false-pass the incident
//   3. fail-closed path — with an unreachable proxy forced, validate must
//      fail AND be classified as a network error (the path that exits 2),
//      proving offline can never skip-pass

async function selfTest(binPath) {
  console.log('check-server-json: self-test leg 1/3 — positive control (canary @ HEAD must pass)');
  const canaryResult = checkConnector(binPath, 'canary'); // throws/exits on failure
  if (canaryResult.verdict !== 'PASS') throw new Error(`expected canary to PASS, got ${canaryResult.verdict}`);

  console.log('check-server-json: self-test leg 2/3 — incident replay (134-char description must FAIL)');
  if (INCIDENT_DESCRIPTION.length !== 134) {
    throw new Error(`fixture drift: incident description is ${INCIDENT_DESCRIPTION.length} chars, expected 134`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'check-server-json-'));
  try {
    const fixture = readJson(join(repoRoot, 'connectors', 'canary', 'server.json'));
    fixture.description = INCIDENT_DESCRIPTION;
    const fixturePath = join(tmp, 'server.json');
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
    const { status, output } = runValidate(binPath, fixturePath);
    if (status === 0) {
      throw new Error(
        'INCIDENT FIXTURE PASSED — the registry round-trip is no longer being exercised. ' +
          'This check would false-pass the 260611 canary incident; do not trust its PASS results.',
      );
    }
    if (NETWORK_ERROR_RE.test(output)) failClosed(`registry unreachable during incident replay:\n${output.trim()}`);
    if (!/length <= 100|422/i.test(output)) {
      throw new Error(`incident fixture failed for an unexpected reason (wanted the length-limit 422):\n${output.trim()}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('check-server-json: self-test leg 3/3 — fail-closed path (forced-offline must be a network failure, not a pass)');
  const offline = runValidate(binPath, join(repoRoot, 'connectors', 'canary', 'server.json'), {
    HTTPS_PROXY: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1',
    NO_PROXY: '',
    no_proxy: '',
  });
  if (offline.status === 0) {
    throw new Error(
      'validate PASSED with no network — mcp-publisher is skip-passing offline. ' +
        'The fail-closed guarantee is broken; pin a version whose validate requires the registry round-trip.',
    );
  }
  if (!NETWORK_ERROR_RE.test(offline.output)) {
    throw new Error(
      `forced-offline failure was not classified as a network error — NETWORK_ERROR_RE needs updating:\n${offline.output.trim()}`,
    );
  }

  console.log('check-server-json: self-test PASS (positive control, incident rejection, fail-closed offline)');
}

// --- Main --------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

const binPath = await ensurePublisher();

if (args.includes('--self-test')) {
  try {
    await selfTest(binPath);
  } catch (err) {
    console.error(`check-server-json: SELF-TEST FAILED — ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

let names;
if (args.includes('--all')) {
  // _template is starter scaffolding with placeholders; skip it (mirrors CI).
  names = readdirSync(join(repoRoot, 'connectors'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_template')
    .map((e) => e.name)
    .sort();
} else {
  names = args;
  const bad = names.filter((n) => !/^[a-z0-9][a-z0-9-]*$/.test(n));
  if (bad.length > 0) {
    console.error(`check-server-json: invalid connector name(s): ${bad.join(', ')}\n\n${USAGE}`);
    process.exit(1);
  }
}

const summary = [];
let failures = 0;
for (const name of names) {
  try {
    const { verdict, detail } = checkConnector(binPath, name);
    summary.push(`${verdict} ${name}${detail ? `: ${detail}` : ''}`);
  } catch (err) {
    summary.push(`FAIL ${name}`);
    console.error(`check-server-json: ${err.message}`);
    failures += 1;
  }
}

console.log('\n=== server.json check summary (local) ===');
for (const line of summary) console.log(line);
process.exit(failures > 0 ? 1 : 0);
