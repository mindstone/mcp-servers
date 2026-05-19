#!/usr/bin/env node
// Build the GitHub Pages catalogue under docs/catalogue/ from each connector's
// STATUS.json (preferred) or package.json + server.json (fallback). Read-only
// aggregator: writes only into docs/catalogue/ and docs/index.md.
//
// Usage:
//   node scripts/build-catalogue.mjs            # write to disk
//   node scripts/build-catalogue.mjs --check    # exit non-zero if outputs would change
//
// Inputs (per connector):
//   connectors/<name>/STATUS.json       (preferred)
//   connectors/<name>/package.json
//   connectors/<name>/server.json       (optional)
//   connectors/<name>/README.md         (tagline + positioning line extracted)
//
// Outputs:
//   docs/index.md                       (landing page + sortable table)
//   docs/catalogue/<name>.md            (per-connector page)
//   docs/_config.yml                    (Jekyll config; created if missing)

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const connectorsDir = join(repoRoot, 'connectors');
const docsDir = join(repoRoot, 'docs');
const catalogueDir = join(docsDir, 'catalogue');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const REPO_URL = 'https://github.com/mindstone/mcp-servers';

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readTextIfExists(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function listConnectors() {
  return readdirSync(connectorsDir)
    .filter((name) => name !== '_template')
    .filter((name) => statSync(join(connectorsDir, name)).isDirectory())
    .sort();
}

// Pull the one-line tagline (first non-empty paragraph after the H1) and
// the italic positioning line (if present) from a connector README.
function extractTaglineAndPositioning(readmePath) {
  const text = readTextIfExists(readmePath);
  if (!text) return { tagline: null, positioning: null };
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('# ')) i++;
  if (i >= lines.length) return { tagline: null, positioning: null };
  i++;
  // Skip blank lines and any badge / image lines starting with [![ or ![.
  while (
    i < lines.length &&
    (lines[i].trim() === '' ||
      lines[i].trim().startsWith('[![') ||
      lines[i].trim().startsWith('![') ||
      lines[i].trim().startsWith('<!--'))
  ) {
    i++;
  }
  const tagline = lines[i]?.trim() || null;
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const candidate = lines[i]?.trim() || '';
  const positioning =
    candidate.startsWith('*') && candidate.endsWith('*') && !candidate.startsWith('**')
      ? candidate.replace(/^\*|\*$/g, '').trim()
      : null;
  return { tagline, positioning };
}

function buildConnectorInfo(name) {
  const dir = join(connectorsDir, name);
  const status = readJsonIfExists(join(dir, 'STATUS.json'));
  const pkg = readJsonIfExists(join(dir, 'package.json'));
  const server = readJsonIfExists(join(dir, 'server.json'));
  const { tagline, positioning } = extractTaglineAndPositioning(join(dir, 'README.md'));

  const envVars = server?.packages?.[0]?.environmentVariables ?? [];
  const secretEnvNames = envVars.filter((e) => e.isSecret || /KEY|TOKEN|SECRET/.test(e.name)).map((e) => e.name);

  return {
    name,
    package: status?.package ?? pkg?.name ?? null,
    version: status?.version ?? pkg?.version ?? null,
    description: pkg?.description ?? null,
    tagline,
    positioning,
    auth: status?.auth ?? { type: 'unknown', envVars: secretEnvNames },
    tools: status?.tools ?? { count: null, domains: [] },
    surface: status?.surface ?? null,
    hostsTested: status?.hostsTested ?? null,
    evidence: status?.evidence ?? null,
    lastVerifiedAgainstApi: status?.lastVerifiedAgainstApi ?? null,
    hasStatus: !!status,
    npmUrl: pkg?.name ? `https://www.npmjs.com/package/${pkg.name}` : null,
    serverJsonUrl: existsSync(join(dir, 'server.json'))
      ? `${REPO_URL}/blob/main/connectors/${name}/server.json`
      : null,
    statusJsonUrl: status ? `${REPO_URL}/blob/main/connectors/${name}/STATUS.json` : null,
    sourceUrl: `${REPO_URL}/tree/main/connectors/${name}`,
    readmeUrl: `${REPO_URL}/blob/main/connectors/${name}/README.md`,
  };
}

const HOST_LABELS = {
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  'mindstone-rebel': 'Mindstone Rebel',
  windsurf: 'Windsurf',
  vscode: 'VS Code',
  raycast: 'Raycast',
};

const AUTH_LABELS = {
  'api-key': 'API key',
  'basic-auth': 'Basic auth',
  'oauth-host-orchestrated': 'OAuth (host-orchestrated)',
  'oauth-local-callback': 'OAuth (local 127.0.0.1 callback)',
  'oauth-client-credentials': 'OAuth (client credentials)',
  oauth: 'OAuth',
  none: 'None',
  hybrid: 'Hybrid',
  unknown: 'Unknown',
};

const SURFACE_LABELS = {
  'cloud-api': 'cloud API',
  'desktop-addin': 'desktop add-in',
  'local-cli': 'local CLI',
  'browser-automation': 'browser automation',
  'local-protocol': 'local protocol',
  TBD: 'TBD',
};

function formatHosts(hosts) {
  if (!hosts || hosts.length === 0) return '—';
  return hosts.map((h) => HOST_LABELS[h] ?? h).join(', ');
}

function formatAuth(auth) {
  if (!auth || !auth.type) return '—';
  return AUTH_LABELS[auth.type] ?? auth.type;
}

function formatSurface(surface) {
  if (!surface) return '—';
  return SURFACE_LABELS[surface] ?? surface;
}

function indexPage(connectors) {
  const rows = connectors
    .map((c) => {
      const link = `[${c.name}](./catalogue/${c.name}.html)`;
      const auth = formatAuth(c.auth);
      const tools = c.tools?.count ?? '—';
      const surface = formatSurface(c.surface);
      const version = c.version ?? '—';
      const tagline = c.tagline ?? c.description ?? '';
      const taglineCol = tagline ? tagline.replace(/\|/g, '\\|') : '—';
      return `| ${link} | ${taglineCol} | ${version} | ${auth} | ${tools} | ${surface} |`;
    })
    .join('\n');

  return `---
layout: default
title: mcp-servers catalogue
---

# mcp-servers catalogue

A machine-readable index of the [mindstone/mcp-servers](${REPO_URL}) monorepo: ${connectors.length} source-available MCP servers, audited weekly by the [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/mindstone/mcp-servers).

Each row links to a per-connector page generated from the connector's \`STATUS.json\`. The data on this site is derived from the source repository on every push to \`main\` — if it looks stale, the data isn't.

| Connector | What it does | Version | Auth | Tools | Surface |
|-----------|--------------|---------|------|-------|---------|
${rows}

## How this catalogue is built

- The source of truth for each row is \`connectors/<name>/STATUS.json\` in the repo. The file is validated by \`scripts/check-status.mjs\` on every PR.
- This page is regenerated from those JSON files by \`scripts/build-catalogue.mjs\` and published via GitHub Pages. The generator is read-only — it never modifies a connector directory.
- Connectors without a \`STATUS.json\` yet are listed with derived data from \`package.json\` and \`server.json\`; their per-connector pages are marked \`status: pending\`.

## See also

- [Repository on GitHub](${REPO_URL})
- [Security policy](${REPO_URL}/blob/main/SECURITY.md)
- [Migration guide for the \`@mindstone-engineering/\` → \`@mindstone/\` scope change](${REPO_URL}/blob/main/MIGRATION.md)
- [Connector README guide](${REPO_URL}/blob/main/docs/CONNECTOR_README_GUIDE.md)
`;
}

function connectorPage(c) {
  const evidenceRows = [];
  if (c.evidence?.changelog) evidenceRows.push(`| Changelog | [\`CHANGELOG.md\`](${REPO_URL}/blob/main/connectors/${c.name}/CHANGELOG.md) |`);
  if (c.evidence?.tools) evidenceRows.push(`| Tools source | [\`${c.evidence.tools.replace(/^\.\//, '')}\`](${REPO_URL}/tree/main/connectors/${c.name}/${c.evidence.tools.replace(/^\.\//, '')}) |`);
  if (c.evidence?.tests) evidenceRows.push(`| Tests | [\`${c.evidence.tests.replace(/^\.\//, '')}\`](${REPO_URL}/tree/main/connectors/${c.name}/${c.evidence.tests.replace(/^\.\//, '')}) |`);
  if (c.statusJsonUrl) evidenceRows.push(`| Machine-readable status | [\`STATUS.json\`](${c.statusJsonUrl}) |`);
  if (c.serverJsonUrl) evidenceRows.push(`| MCP server manifest | [\`server.json\`](${c.serverJsonUrl}) |`);
  if (c.npmUrl) evidenceRows.push(`| npm package | [${c.package}](${c.npmUrl}) |`);
  evidenceRows.push(`| Source directory | [\`connectors/${c.name}/\`](${c.sourceUrl}) |`);
  evidenceRows.push(`| README | [\`README.md\`](${c.readmeUrl}) |`);

  const authEnvVars = (c.auth?.envVars ?? []).map((n) => `\`${n}\``).join(', ') || '—';
  const domains = c.tools?.domains?.length ? c.tools.domains.join(', ') : '—';

  const pendingNotice = c.hasStatus
    ? ''
    : `\n> **Status: pending.** This connector does not yet have a \`STATUS.json\`. The values below are derived from \`package.json\` and \`server.json\` and have not been editorially reviewed.\n`;

  return `---
layout: default
title: ${c.name} — mcp-servers catalogue
---

# ${c.name}

${c.tagline ?? c.description ?? ''}

${c.positioning ? `*${c.positioning}*` : ''}
${pendingNotice}
## Status

| Field | Value |
|-------|-------|
| Version | ${c.version ?? '—'} |
| Auth | ${formatAuth(c.auth)} (${authEnvVars}) |
| Tools | ${c.tools?.count ?? '—'} (${domains}) |
| Surface | ${formatSurface(c.surface)} |
| Hosts tested | ${formatHosts(c.hostsTested)} |

## Evidence

| Artefact | Location |
|----------|----------|
${evidenceRows.join('\n')}

## Install

\`\`\`bash
npx -y ${c.package}
\`\`\`

Add to your MCP host configuration; see the [README](${c.readmeUrl}) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)
`;
}

function jekyllConfig() {
  return `# Generated alongside docs/catalogue/. Edit scripts/build-catalogue.mjs.
title: mcp-servers catalogue
description: Source-available MCP servers by Mindstone — machine-readable index.
url: https://mindstone.github.io
baseurl: /mcp-servers
theme: jekyll-theme-minimal
markdown: kramdown
permalink: /:path/:basename:output_ext

# Allowlist: only these paths are published. Everything else under docs/ stays
# in-repo (and browseable on github.com) but is NOT served by GitHub Pages.
# This is deliberate — docs/ contains internal release-operations runbooks
# (PUBLISH_APPROVAL_PROCESS.md, EMERGENCY_REVOKE.md, plans/), security audits,
# and a Jekyll-incompatible JSON schema that must not appear on the public site.
exclude:
  - '*'
  - '*/'

include:
  - index.md
  - catalogue
  - assets
`;
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function writeIfChanged(path, content) {
  const existing = readIfExists(path);
  if (existing === content) return false;
  if (checkOnly) {
    console.error(`drift: ${path}`);
    return true;
  }
  ensureDir(dirname(path));
  writeFileSync(path, content);
  return true;
}

const connectors = listConnectors().map(buildConnectorInfo);

let drifted = false;

drifted = writeIfChanged(join(docsDir, '_config.yml'), jekyllConfig()) || drifted;
drifted = writeIfChanged(join(docsDir, 'index.md'), indexPage(connectors)) || drifted;
ensureDir(catalogueDir);

// Track files we own so we can prune stale per-connector pages.
const owned = new Set([join(docsDir, '_config.yml'), join(docsDir, 'index.md')]);

for (const c of connectors) {
  const out = join(catalogueDir, `${c.name}.md`);
  owned.add(out);
  drifted = writeIfChanged(out, connectorPage(c)) || drifted;
}

// Remove stale catalogue files (e.g. a removed connector). Only touch files
// directly inside docs/catalogue/.
if (existsSync(catalogueDir)) {
  for (const entry of readdirSync(catalogueDir)) {
    const full = join(catalogueDir, entry);
    if (!owned.has(full) && entry.endsWith('.md')) {
      if (checkOnly) {
        console.error(`drift: stale ${full}`);
        drifted = true;
      } else {
        unlinkSync(full);
      }
    }
  }
}

if (checkOnly && drifted) {
  console.error('build-catalogue: catalogue is out of date; run `node scripts/build-catalogue.mjs`');
  process.exit(1);
}

console.log(`build-catalogue: wrote catalogue for ${connectors.length} connectors`);
