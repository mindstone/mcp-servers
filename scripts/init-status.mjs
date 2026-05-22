#!/usr/bin/env node
// Generate a draft connectors/<name>/STATUS.json from package.json, server.json,
// and a static scan of src/. Per AGENTS.md, this script operates on ONE
// connector at a time.
//
// Usage:
//   node scripts/init-status.mjs <connector-name>
//
// Writes:
//   connectors/<connector-name>/STATUS.json
//
// Fields populated automatically:
//   - name, package, version, auth.envVars, tools.count, evidence.*
//
// Fields left for the human to set:
//   - auth.type (best-effort inferred; verify)
//   - tools.domains (editorial grouping)
//   - surface (one of: cloud-api | desktop-addin | local-cli | browser-automation | …)
//   - lastVerifiedAgainstApi (null; CI sets this)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function fail(msg) {
  console.error(`init-status: ${msg}`);
  process.exit(1);
}

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
  // Fallback for connectors that register tools via an `allTools` array consumed
  // by `setRequestHandler(ListToolsRequestSchema, ...)` instead of per-tool
  // `registerTool()` calls (hubspot pattern). Count `name: 'snake_case_id'`
  // entries inside files under src/ that look like tool definitions.
  for (const f of files) {
    if (!/(\/|\\)definitions\.ts$/.test(f) && !/tools\.ts$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    const matches = text.match(/\bname:\s*['"][a-z][a-z0-9_]*['"]/g);
    if (matches) count += matches.length;
  }
  return count;
}

function inferAuthType(envVars) {
  const names = envVars.map((e) => e.name);
  const has = (re) => names.some((n) => re.test(n));
  if (has(/CONFIG_PATH|CONFIG_DIR|BRIDGE_STATE/) && has(/CLIENT_ID|CLIENT_SECRET/)) {
    return 'oauth-host-orchestrated';
  }
  if (has(/CLIENT_ID|CLIENT_SECRET/) && has(/REFRESH_TOKEN|REDIRECT/)) {
    return 'oauth-local-callback';
  }
  if (has(/REFRESH_TOKEN/) || has(/ACCESS_TOKEN/)) return 'oauth';
  if (has(/API_KEY|API_TOKEN|APIKEY/)) return 'api-key';
  if (envVars.length === 0) return 'none';
  return 'unknown';
}

const connector = process.argv[2];
if (!connector) fail('usage: node scripts/init-status.mjs <connector-name>');

const dir = join(repoRoot, 'connectors', connector);
if (!existsSync(dir)) fail(`connector directory not found: ${dir}`);

const pkgPath = join(dir, 'package.json');
const serverPath = join(dir, 'server.json');
const srcDir = join(dir, 'src');

if (!existsSync(pkgPath)) fail(`missing package.json at ${pkgPath}`);
const pkg = readJson(pkgPath);

let server = null;
if (existsSync(serverPath)) {
  server = readJson(serverPath);
}

const envVars =
  server?.packages?.[0]?.environmentVariables?.map((e) => ({
    name: e.name,
    isSecret: !!e.isSecret,
    isRequired: !!e.isRequired,
  })) ?? [];

const authEnvVars = envVars.filter((e) => e.isSecret || /KEY|TOKEN|SECRET/.test(e.name)).map((e) => e.name);
const authType = inferAuthType(envVars);
const toolCount = existsSync(srcDir) ? countRegisterToolCalls(srcDir) : 0;

const status = {
  $schema: '../../docs/status.schema.json',
  schemaVersion: 1,
  name: connector,
  package: pkg.name,
  version: pkg.version,
  auth: {
    type: authType,
    envVars: authEnvVars,
  },
  tools: {
    count: toolCount,
    domains: [],
  },
  surface: 'TBD',
  evidence: {
    changelog: './CHANGELOG.md',
    tools: existsSync(join(dir, 'src', 'tools')) ? './src/tools/' : './src/',
    auth: './src/',
    tests: existsSync(join(dir, 'test')) ? './test/' : null,
    npm: pkg.name ? `https://www.npmjs.com/package/${pkg.name}` : null,
    serverJson: existsSync(serverPath) ? './server.json' : null,
  },
};

// Drop null evidence keys for cleanliness.
for (const k of Object.keys(status.evidence)) {
  if (status.evidence[k] === null) delete status.evidence[k];
}

const out = join(dir, 'STATUS.json');
writeFileSync(out, JSON.stringify(status, null, 2) + '\n');

console.log(`Wrote ${out}`);
console.log('');
console.log('Human review required for these fields:');
console.log(`  - auth.type:      ${authType} (verify against actual auth code)`);
console.log(`  - tools.domains:  [] (group tools into 2–4 editorial buckets)`);
console.log(`  - surface:        TBD (cloud-api | desktop-addin | local-cli | browser-automation)`);
