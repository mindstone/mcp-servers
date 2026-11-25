#!/usr/bin/env node
// Writes the connectors' copies of the shared source files from test-harness/src/.
//
// Usage:
//   node scripts/sync-shared-sources.mjs          # rewrite every stale copy
//   node scripts/sync-shared-sources.mjs --check  # write nothing; exit 1 naming each stale copy
//
// A connector carries its own copy of each file it uses (bridge-reader.ts,
// hardened-json-file.ts) under its src/, so its package, its git tree and the
// release security review all hold the exact code it ships. Never edit a copy:
// change the file in test-harness/src/ and run this. It rewrites only copies
// that exist; to adopt a file for the first time, copy it from test-harness/src/
// into the connector's src/ once. check-bridge-reader.mjs reruns this check.

import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');

export const CANONICAL = Object.fromEntries(
  ['bridge-reader.ts', 'hardened-json-file.ts'].map((name) => [
    name,
    readFileSync(join(repoRoot, 'test-harness', 'src', name), 'utf8'),
  ]),
);

// The command that rewrites the copies, as run from the current directory, quoted for pasting
// into the usual shell (single quotes for POSIX shells, double quotes on Windows).
const relScript = relative(process.cwd(), scriptPath) || scriptPath;
const shownScript = relScript.startsWith('-') ? `./${relScript}` : relScript; // never read as a node option
const quoted = /^[\w@%+=:,./\\-]+$/.test(shownScript)
  ? shownScript
  : process.platform === 'win32'
    ? `"${shownScript}"`
    : `'${shownScript.replaceAll("'", `'\\''`)}'`;
export const SYNC_COMMAND = `node ${quoted}`;

// Every copy under dir (node_modules skipped), with whether it matches its canonical file.
// Links are not supported in a connector: a link anywhere (the connector folder, its src/ or
// anything below, dangling or not) is reported as stale and never followed, read or written, so
// no copy goes unchecked and nothing is written outside the connector. A person replaces it.
export function copiesIn(dir) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) return [{ path: dir, name: null, stale: true, link: true }];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === 'node_modules') return [];
    if (entry.isSymbolicLink()) return [{ path, name: null, stale: true, link: true }];
    if (entry.isDirectory()) return copiesIn(path);
    if (entry.isFile() && Object.hasOwn(CANONICAL, entry.name)) {
      return [{ path, name: entry.name, stale: readFileSync(path, 'utf8') !== CANONICAL[entry.name] }];
    }
    return [];
  });
}

// Every copy in every connector's src/, and every connector folder that is a link.
export function connectorCopies(connectorsRoot = join(repoRoot, 'connectors')) {
  return readdirSync(connectorsRoot, { withFileTypes: true }).flatMap((entry) => {
    const path = join(connectorsRoot, entry.name);
    if (entry.isSymbolicLink()) return [{ path, name: null, stale: true, link: true }];
    return entry.isDirectory() ? copiesIn(join(path, 'src')) : [];
  });
}

// Why a stale copy fails.
export const staleReason = (c) =>
  c.link
    ? 'is a symlink, and links are not supported in a connector: replace it with a real file or folder'
    : `differs from test-harness/src/${c.name}`;

// Rewrites each stale copy and returns them. A link is left alone: only a person can say what belongs there.
export function sync(copies) {
  const stale = copies.filter((c) => c.stale && !c.link);
  for (const c of stale) writeFileSync(c.path, CANONICAL[c.name]);
  return stale;
}

const runDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    return false; // argv[1] is not a file (a loader or wrapper), so this was imported
  }
};

if (process.argv[1] && runDirectly()) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--check')) {
    console.error('usage: node scripts/sync-shared-sources.mjs [--check]');
    process.exit(2);
  }
  const check = args.includes('--check');
  const shown = (c) => relative(process.cwd(), c.path);
  const count = (n) => `${n} ${n === 1 ? 'copy' : 'copies'}`;
  if (!check) for (const c of sync(connectorCopies())) console.log(`sync-shared-sources: wrote ${shown(c)}`);
  const copies = connectorCopies();
  const stale = copies.filter((c) => c.stale);
  for (const c of stale) console.error(`sync-shared-sources: ${shown(c)} ${staleReason(c)}`);
  if (stale.length > 0) {
    console.error(`\nsync-shared-sources: ${count(stale.length)} stale${check ? `; run: ${SYNC_COMMAND}` : ''}`);
    process.exit(1);
  }
  console.log(`sync-shared-sources: all ${count(copies.length)} match test-harness/src/`);
}
