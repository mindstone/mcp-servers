#!/usr/bin/env node
// Verify connectors/<name>/STATUS.json is in sync with package.json, server.json,
// and the actual src/ tool registrations. Per AGENTS.md, this script operates
// on ONE connector at a time.
//
// Usage:
//   node scripts/check-status.mjs <connector-name>
//
// Exits 0 on success, non-zero on any drift.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function countRegisterToolCalls(srcDir) {
  const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
  let count = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const matches = text.match(/\bregisterTool\s*\(/g);
    if (matches) count += matches.length;
  }
  if (count > 0) return count;
  // Fallback: connectors that register tools via an `allTools` array + a
  // `ListToolsRequestSchema` request handler (hubspot pattern). Look for
  // `name: 'snake_case_id'` entries in tool-definition files.
  for (const f of files) {
    if (!/(\/|\\)definitions\.ts$/.test(f) && !/tools\.ts$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    const matches = text.match(/\bname:\s*['"][a-z][a-z0-9_]*['"]/g);
    if (matches) count += matches.length;
  }
  return count;
}

const connector = process.argv[2];
if (!connector) {
  console.error('usage: node scripts/check-status.mjs <connector-name>');
  process.exit(2);
}

const dir = join(repoRoot, 'connectors', connector);
const errors = [];

const statusPath = join(dir, 'STATUS.json');
if (!existsSync(statusPath)) {
  console.error(`check-status: STATUS.json not found at ${statusPath}`);
  process.exit(1);
}
const status = readJson(statusPath);

if (status.schemaVersion !== 1) {
  errors.push(
    `status.schemaVersion is ${status.schemaVersion}; this checker only knows schemaVersion 1. ` +
      `Regenerate via 'node scripts/init-status.mjs ${connector}' or migrate manually.`
  );
}

const pkg = readJson(join(dir, 'package.json'));
if (status.package !== pkg.name) {
  errors.push(`status.package (${status.package}) != package.json name (${pkg.name})`);
}
if (status.version !== pkg.version) {
  errors.push(`status.version (${status.version}) != package.json version (${pkg.version})`);
}
if (status.name !== connector) {
  errors.push(`status.name (${status.name}) != connector directory (${connector})`);
}

const serverPath = join(dir, 'server.json');
if (existsSync(serverPath)) {
  const server = readJson(serverPath);
  if (status.version !== server.version) {
    errors.push(`status.version (${status.version}) != server.json version (${server.version})`);
  }
  const serverEnvNames = (server.packages?.[0]?.environmentVariables ?? [])
    .filter((e) => e.isSecret || /KEY|TOKEN|SECRET/.test(e.name))
    .map((e) => e.name);
  const statusEnvNames = status.auth?.envVars ?? [];
  const missing = serverEnvNames.filter((n) => !statusEnvNames.includes(n));
  const extra = statusEnvNames.filter((n) => !serverEnvNames.includes(n));
  if (missing.length) errors.push(`status.auth.envVars missing: ${missing.join(', ')}`);
  if (extra.length) errors.push(`status.auth.envVars has extras not in server.json: ${extra.join(', ')}`);
}

const srcDir = join(dir, 'src');
if (existsSync(srcDir)) {
  const actual = countRegisterToolCalls(srcDir);
  if (status.tools?.count !== actual) {
    errors.push(`status.tools.count (${status.tools?.count}) != actual registerTool() calls in src/ (${actual})`);
  }
}

if (!status.surface || status.surface === 'TBD') {
  errors.push('status.surface is unset (TBD) — set to one of cloud-api | desktop-addin | local-cli | browser-automation');
}

if (!Array.isArray(status.hostsTested) || status.hostsTested.length === 0) {
  errors.push('status.hostsTested must be a non-empty array');
}

const readmePath = join(dir, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  const headingMatch = readme.match(/^##\s+(?:Available\s+)?Tools\s+\((\d+)\)/m);
  if (headingMatch) {
    const headingCount = Number(headingMatch[1]);
    if (headingCount !== status.tools?.count) {
      errors.push(
        `README '## Tools (${headingCount})' heading != STATUS.json tools.count (${status.tools?.count})`
      );
    }
  }
}

if (errors.length) {
  console.error(`check-status: ${connector} — drift detected:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`check-status: ${connector} OK`);
