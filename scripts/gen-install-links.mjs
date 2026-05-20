#!/usr/bin/env node
// Regenerate the one-click install block in every connector README.
//
// Idempotent. The block is delimited by:
//   <!-- BEGIN INSTALL_LINKS: ... -->
//   <!-- END INSTALL_LINKS -->
// On first run for a connector that has no markers yet, the block is inserted
// immediately before the connector's "## Quick Start" heading (or before the
// first H2 if Quick Start is absent), so the buttons land at the top of the
// README where one-click conversion happens. After that, only the marker block
// itself is replaced; all surrounding prose is left untouched.
//
// Usage:
//   node scripts/gen-install-links.mjs            # write changes
//   node scripts/gen-install-links.mjs --check    # exit non-zero on drift (CI mode)
//
// Mirrors the conventions of scripts/build-catalogue.mjs:
//   - .mjs / native ESM, no extra dev deps required
//   - hard slug allow-list independent of CI
//   - exclusions list mirrors build-catalogue.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInstallLinks, renderInstallBlock } from './lib/install-links.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const connectorsDir = join(repoRoot, 'connectors');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

// Mirrors CATALOGUE_EXCLUSIONS in scripts/build-catalogue.mjs. Keep them in sync.
const EXCLUSIONS = new Set(['_template', 'google-workspace']);

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const BEGIN_RE = /<!--\s*BEGIN\s+INSTALL_LINKS\b[\s\S]*?-->/;
const END_MARKER = '<!-- END INSTALL_LINKS -->';

function listConnectors() {
  return readdirSync(connectorsDir)
    .filter((name) => !EXCLUSIONS.has(name))
    .filter((name) => statSync(join(connectorsDir, name)).isDirectory())
    .filter((name) => {
      if (SLUG_RE.test(name)) return true;
      console.error(
        `gen-install-links: refusing to process connector with non-slug name '${name}'`
      );
      process.exit(2);
    })
    .sort();
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Choose where to insert a brand-new INSTALL_LINKS block in a README that
// doesn't yet have markers.
//   1. Prefer immediately BEFORE "## Quick Start" — that section is where
//      installation guidance already lives in every existing connector.
//   2. Otherwise, BEFORE the first H2.
//   3. Otherwise, at end of file.
// Headings inside fenced code blocks (``` ... ```) are skipped so a future
// README that demonstrates Markdown inside a fence doesn't trick us into
// inserting the block in the middle of a code example.
// Returns a line index (0-based, exclusive upper bound) suitable for splicing.
function findInsertionLineIndex(text) {
  const lines = text.split('\n');
  const inFence = new Array(lines.length).fill(false);
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    inFence[i] = fenceOpen;
    if (/^```/.test(lines[i])) fenceOpen = !fenceOpen;
  }
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s+Quick\s+Start\b/i.test(lines[i])) return i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s+/.test(lines[i])) return i;
  }
  return lines.length;
}

function applyInstallBlock(readmeText, block) {
  const startIdx = readmeText.search(BEGIN_RE);
  const endIdx = readmeText.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace the existing marker block in-place. We splice from BEGIN to the
    // end of END_MARKER so adjacent whitespace is preserved.
    const endPos = endIdx + END_MARKER.length;
    return readmeText.slice(0, startIdx) + block + readmeText.slice(endPos);
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new Error(
      'gen-install-links: README has only one of BEGIN/END INSTALL_LINKS markers; refusing to write'
    );
  }
  // First run: insert at the chosen line.
  const lines = readmeText.split('\n');
  const insertAt = findInsertionLineIndex(readmeText);
  const head = lines.slice(0, insertAt).join('\n');
  const tail = lines.slice(insertAt).join('\n');
  // Make sure we have exactly one blank line on each side of the inserted block,
  // independent of pre-existing trailing whitespace.
  const headTrimmed = head.replace(/[ \t]+$/g, '').replace(/\n+$/g, '');
  const tailTrimmed = tail.replace(/^\n+/g, '');
  return headTrimmed + '\n\n' + block + '\n\n' + tailTrimmed + (readmeText.endsWith('\n') ? '' : '');
}

const connectors = listConnectors();
let drifted = false;
let processed = 0;
let skipped = 0;

for (const slug of connectors) {
  const dir = join(connectorsDir, slug);
  const serverJson = readJsonIfExists(join(dir, 'server.json'));
  if (!serverJson) {
    console.error(`gen-install-links: ${slug} has no server.json — skipping`);
    skipped++;
    continue;
  }
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    console.error(`gen-install-links: ${slug} has no README.md — skipping`);
    skipped++;
    continue;
  }

  let block;
  try {
    block = renderInstallBlock(buildInstallLinks(slug, serverJson));
  } catch (err) {
    console.error(`gen-install-links: ${slug} — ${err.message}`);
    process.exit(2);
  }

  const original = readFileSync(readmePath, 'utf8');
  let next;
  try {
    next = applyInstallBlock(original, block);
  } catch (err) {
    console.error(`gen-install-links: ${slug} — ${err.message}`);
    process.exit(2);
  }
  if (next === original) {
    processed++;
    continue;
  }
  if (checkOnly) {
    console.error(`drift: ${readmePath}`);
    drifted = true;
  } else {
    writeFileSync(readmePath, next);
    console.log(`wrote: ${readmePath}`);
  }
  processed++;
}

if (checkOnly && drifted) {
  console.error(
    'gen-install-links: install-links block is out of date in one or more READMEs; ' +
      'run `node scripts/gen-install-links.mjs` and commit the result.'
  );
  process.exit(1);
}

console.log(
  `gen-install-links: ${checkOnly ? 'checked' : 'wrote'} ${processed} connectors` +
    (skipped ? ` (skipped ${skipped})` : '')
);
