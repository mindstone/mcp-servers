#!/usr/bin/env node
// Hardened bridge reader gate. Mirrors check-untrusted-coverage.mjs.
//
// Usage:
//   node scripts/check-bridge-reader.mjs <connector-name>
//   node scripts/check-bridge-reader.mjs --all [--base <git-ref>]  # every connector, _template included;
//                                     # with --base, also fail a baseline entry the ref's baseline lacks
//   node scripts/check-bridge-reader.mjs --self-test  # the gate's own regression cases
//
// A connector reads the host app bridge when its non-test source names either
// bridge env var (MCP_HOST_BRIDGE_STATE, or the legacy MINDSTONE_REBEL_BRIDGE_STATE).
// Such a connector is COMPLIANT when:
//   - it carries src/bridge-reader.ts byte-identical to the canonical
//     test-harness/src/bridge-reader.ts,
//   - another non-test source file calls its postToBridge, and
//   - no other non-test source file names either env var or the copy's
//     lower-level readBridgeState / bridgeStatePath outside a comment (so it
//     reads the bridge only through postToBridge).
//
// It FAILS when:
//   - it is not compliant and not listed in scripts/bridge-reader-baseline.json;
//   - a copy of bridge-reader.ts or hardened-json-file.ts (the file primitive
//     bridge-reader.ts imports, also used on its own for a connector's local
//     state files) anywhere under its src/ differs from test-harness/src/,
//     whether or not it is baselined or reads the bridge. The copies are
//     written by scripts/sync-shared-sources.mjs; this reruns its check, and
//     the failure names the command that fixes it;
//   - it is compliant but still baselined (ratchet: remove it from the baseline).
// --all also fails a stale baseline entry (no such connector, or it no longer
// reads the bridge), and with --base an entry the base ref's baseline does not
// have. The baseline can therefore only shrink.
//
// This is attention-forcing, not proof: it cannot see an env var read through
// a computed key. The §13 release security review still reads the code.

import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CANONICAL as SHARED, SYNC_COMMAND, connectorCopies, copiesIn, staleReason, sync } from './sync-shared-sources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CANONICAL = SHARED['bridge-reader.ts'];
const CANONICAL_FILE_READER = SHARED['hardened-json-file.ts'];
const ENV_VARS = /\b(?:MCP_HOST_BRIDGE_STATE|MINDSTONE_REBEL_BRIDGE_STATE)\b/;
const BYPASS = /\b(?:MCP_HOST_BRIDGE_STATE|MINDSTONE_REBEL_BRIDGE_STATE|readBridgeState|bridgeStatePath)\b/;
const CALL = /\bpostToBridge\s*\(/;

let connectorsRoot = join(repoRoot, 'connectors');
let baseline = JSON.parse(readFileSync(join(__dirname, 'bridge-reader-baseline.json'), 'utf8'));

// Never follows a link: any link in a connector fails the check through copiesIn
// (sync-shared-sources.mjs states the rule).
function walk(dir, files = []) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Source files only, never tests (tests legitimately set the env vars).
function sourceFiles(srcDir) {
  return walk(srcDir).filter(
    (f) =>
      /\.[cm]?[jt]s$/.test(f) &&
      !/\.test\.[cm]?[jt]s$/.test(f) &&
      !/(\/|\\)(test|tests|__tests__)(\/|\\)/.test(f),
  );
}

// Blank out comments, keeping strings, template literals (and their `${…}`
// code) and every character's position. A small lexer, not a parser: it does
// not know regex literals, so `/[/*]/` or `/"/` can mislead it into blanking
// code. namesBypass below therefore never trusts it alone.
function stripComments(text) {
  let out = '';
  const resume = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  let inTemplate = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inTemplate) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '`') inTemplate = false;
      else if (c === '$' && next === '{') {
        out += next;
        i += 1;
        depth += 1;
        resume.push(depth);
        inTemplate = false;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      for (; i < text.length && text[i] !== '\n'; i += 1) out += ' ';
      i -= 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += c;
    if (c === '\\') {
      out += next ?? '';
      i += 1;
    } else if (c === "'" || c === '"') {
      for (i += 1; i < text.length && text[i] !== c && text[i] !== '\n'; i += 1) {
        out += text[i];
        if (text[i] === '\\') {
          i += 1;
          out += text[i] ?? '';
        }
      }
      out += text[i] ?? '';
    } else if (c === '`') inTemplate = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      if (resume.at(-1) === depth) {
        resume.pop();
        inTemplate = true;
      }
      depth -= 1;
    }
  }
  return out;
}

// A line naming a bypass counts as a comment only when the lexer blanked the
// name AND the line itself starts with a comment marker, as env var docs are
// written. A lexer mistake can then only fail a connector, never pass one.
function namesBypass(text) {
  const code = stripComments(text).split('\n');
  return text
    .split('\n')
    .some((line, i) => BYPASS.test(line) && (BYPASS.test(code[i]) || !/^\s*(?:\/\/|\/\*|\*)/.test(line)));
}

function evaluateConnector(connector) {
  const tag = `check-bridge-reader: ${connector}`;
  const dir = join(connectorsRoot, connector);
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return { ok: false, readsBridge: false, message: `${tag} — the connector folder ${staleReason({ link: true })}.` };
  }
  if (!existsSync(dir)) return { ok: false, readsBridge: false, message: `${tag} — connector directory not found` };
  const files = sourceFiles(join(dir, 'src'));
  const texts = files.map((f) => [f, readFileSync(f, 'utf8')]);
  const readsBridge = texts.some(([, t]) => ENV_VARS.test(t));
  const baselined = (baseline.gappedConnectors ?? []).includes(connector);
  const result = (ok, message) => ({ ok, readsBridge, message: `${tag} ${message}` });

  // Every copy anywhere under src/, test folders included (wider than sourceFiles on purpose).
  const stale = copiesIn(join(dir, 'src')).filter((c) => c.stale);
  if (stale.length > 0) {
    return result(
      false,
      `— ${stale.map((c) => `${relative(dir, c.path)} ${staleReason(c)}`).join('; ')}.\n` +
        `  These copies are generated, never edited: run ${SYNC_COMMAND}. For a real change, edit the file in test-harness/src/ and run it.`,
    );
  }
  const copies = texts.filter(([f]) => basename(f) === 'bridge-reader.ts');
  // bridge-reader.ts imports its sibling primitive, so a copy without one cannot build.
  const missingFileReader = copies.filter(([f]) => !existsSync(join(dirname(f), 'hardened-json-file.ts')));
  if (missingFileReader.length > 0) {
    return result(
      false,
      `— ${missingFileReader.map(([f]) => relative(dir, f)).join(', ')} has no hardened-json-file.ts beside it.\n` +
        `  Copy test-harness/src/hardened-json-file.ts next to it once; ${SYNC_COMMAND} keeps it current after that.`,
    );
  }
  if (!readsBridge) {
    return baselined
      ? result(false, '— no longer reads the bridge: remove it from gappedConnectors in scripts/bridge-reader-baseline.json')
      : result(true, 'OK (does not read the bridge)');
  }
  const others = texts.filter(([f]) => basename(f) !== 'bridge-reader.ts');
  const bypasses = others.filter(([, t]) => namesBypass(t)).map(([f]) => relative(dir, f));
  const calls = others.some(([, t]) => CALL.test(stripComments(t)));
  const compliant = copies.length > 0 && calls && bypasses.length === 0;
  if (compliant) {
    return baselined
      ? result(false, '— now reads the bridge only through the hardened copy: remove it from gappedConnectors in scripts/bridge-reader-baseline.json (ratchet)')
      : result(true, 'OK (reads the bridge through the vendored hardened reader)');
  }
  if (baselined) return result(true, 'OK (baselined known gap)');
  const why =
    copies.length === 0
      ? 'has no src/bridge-reader.ts'
      : bypasses.length > 0
        ? `names the bridge env vars, readBridgeState or bridgeStatePath outside src/bridge-reader.ts (${bypasses.join(', ')})`
        : 'never calls its postToBridge (remove an unused copy)';
  return result(
    false,
    `— FAILS: reads the host app bridge but ${why}.\n` +
      `  Copy test-harness/src/bridge-reader.ts and test-harness/src/hardened-json-file.ts to src/ once (${SYNC_COMMAND} keeps\n` +
      `  them current after that) and send bridge requests through its postToBridge (connectors/_template/src/bridge.ts shows how).`,
  );
}

function discoverConnectors() {
  return readdirSync(connectorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()) // a linked connector fails, never hides
    .map((entry) => entry.name)
    .sort();
}

// Entries in the current baseline that the base ref's baseline lacks.
function grownEntries(current, base) {
  return current.filter((c) => !base.includes(c));
}

const git = (args) => execFileSync('git', args, { cwd: __dirname, stdio: 'pipe' }).toString('utf8');

// The base ref's baseline entries, or null when the file does not exist there
// (its first change). Absence is read from the tree; a baseline that exists but
// cannot be read or parsed (CI's blobless fetch can miss the blob) throws, so it
// can never pass as absent.
function baseBaseline(ref, run = git) {
  const file = `${ref}:./bridge-reader-baseline.json`;
  try {
    run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`--base ${ref} is not a commit here (is its history fetched?)`);
  }
  if (run(['ls-tree', '--name-only', ref, '--', 'bridge-reader-baseline.json']).trim() === '') return null;
  try {
    const entries = JSON.parse(run(['show', file])).gappedConnectors;
    if (!Array.isArray(entries)) throw new Error('no gappedConnectors list');
    return entries;
  } catch (err) {
    throw new Error(`could not read the baseline at ${ref} (${err.message.split('\n')[0]})`);
  }
}

function sweep() {
  const connectors = discoverConnectors();
  const lines = [];
  let failed = 0;
  for (const c of connectors) {
    const { ok, message } = evaluateConnector(c);
    lines.push(message);
    if (!ok) failed += 1;
  }
  for (const c of baseline.gappedConnectors ?? []) {
    if (!connectors.includes(c)) {
      lines.push(`check-bridge-reader: ${c} — baselined but no such connector: remove it from scripts/bridge-reader-baseline.json`);
      failed += 1;
    }
  }
  return { connectors, lines, failed };
}

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'bridge-reader-selftest-'));
  const outside = mkdtempSync(join(tmpdir(), 'bridge-reader-selftest-outside-')); // targets of the folder links
  const saved = { connectorsRoot, baseline };
  connectorsRoot = tmp;
  baseline = { gappedConnectors: ['gapped', 'fixed-but-baselined', 'drifted-baselined', 'gone'] };
  // Every fixture copy of bridge-reader.ts gets its sibling primitive, except where a leg tests its absence.
  const make = (name, files, { withSibling = true } = {}) => {
    const all = { ...files };
    for (const rel of Object.keys(files)) {
      const sibling = join(dirname(rel), 'hardened-json-file.ts');
      if (withSibling && basename(rel) === 'bridge-reader.ts' && !(sibling in all)) all[sibling] = CANONICAL_FILE_READER;
    }
    for (const [rel, text] of Object.entries(all)) {
      const p = join(tmp, name, 'src', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  };
  const unsafe = `export const p = process.env.MCP_HOST_BRIDGE_STATE || '';\nJSON.parse(require('fs').readFileSync(p, 'utf8'));\n`;
  const wrapper = `import { postToBridge } from './bridge-reader.js';\nexport const r = () => postToBridge('/x', {}, { connector: 'c', timeoutMs: 1 });\n`;
  const commented = `/**\n * Environment variables:\n * - MCP_HOST_BRIDGE_STATE: bridge state path\n */\n// MINDSTONE_REBEL_BRIDGE_STATE is the legacy name\n${wrapper}`;
  const afterBlock = `${wrapper}/* path */ const p = process.env.MCP_HOST_BRIDGE_STATE;\n`;
  const lowLevel = `import { bridgeStatePath } from './bridge-reader.js';\nimport * as fs from 'fs';\nexport const s = JSON.parse(fs.readFileSync(bridgeStatePath(), 'utf8'));\n${wrapper}`;
  const inString = `${wrapper}const route = '//credentials'; const p = process.env.MCP_HOST_BRIDGE_STATE;\n`;
  const generator = `import * as bridge from './bridge-reader.js';\nimport * as fs from 'fs';\n${wrapper}export class R {\n  *states() { yield JSON.parse(fs.readFileSync(bridge.bridgeStatePath(), 'utf8')); }\n}\n`;
  const inTemplate = `${wrapper}export const s = \`\n// \${process.env.MCP_HOST_BRIDGE_STATE}\n\`;\n`;
  const afterRegex = `${wrapper}export const u = 'a/b'.replace(/\\//g, '-'); const p = process.env.MCP_HOST_BRIDGE_STATE;\n`;
  const regexClass = `${wrapper}const globChars = /[/*?]/;\nconst p = process.env.MCP_HOST_BRIDGE_STATE;\n`;
  const regexQuote = `${wrapper}const quote = /"/g; const url = "https://example.com"; const p = process.env.MCP_HOST_BRIDGE_STATE;\n`;
  const importOnly = `import { postToBridge } from './bridge-reader.js';\nexport { postToBridge };\n`;
  const commentCall = `// postToBridge('/x', {}, opts)\nexport const x = 1;\n`;
  const withFileReader = { 'hardened-json-file.ts': CANONICAL_FILE_READER };
  make('compliant', { ...withFileReader, 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
  make('comment-mention', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': commented });
  make('after-block-comment', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': afterBlock });
  make('low-level-export', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': lowLevel });
  make('slashes-in-string', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': inString });
  make('generator-method', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': generator });
  make('template-interpolation', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': inTemplate });
  make('after-regex', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': afterRegex });
  make('regex-class', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': regexClass });
  make('regex-quote', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': regexQuote });
  make('import-only', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': importOnly });
  make('comment-call', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': commentCall });
  make('unused-copy', { 'bridge-reader.ts': CANONICAL, 'server.ts': 'export const x = 1;\n' });
  make('unhardened', { 'bridge.ts': unsafe });
  make('gapped', { 'bridge.ts': unsafe });
  make('fixed-but-baselined', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
  make('drifted', { 'bridge-reader.ts': CANONICAL + '\n// local tweak\n', 'bridge.ts': wrapper });
  make('drifted-baselined', { 'lib/bridge-reader.ts': CANONICAL.replace("redirect: 'error'", "redirect: 'follow'"), 'bridge.ts': unsafe });
  make('copy-plus-bypass', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper, 'auth.ts': unsafe });
  make('bracket-bypass', { 'bridge-reader.ts': CANONICAL, 'auth.ts': `const p = process.env['MINDSTONE_REBEL_BRIDGE_STATE'];\n` });
  make('no-bridge', { 'server.ts': `export const x = fetch('https://example.com');\n` });
  make('file-reader-only', { ...withFileReader, 'server.ts': 'export const x = 1;\n' });
  make('file-reader-drifted', { 'hardened-json-file.ts': CANONICAL_FILE_READER.replace('O_NOFOLLOW', 'O_RDONLY'), 'server.ts': 'export const x = 1;\n' });
  make('bridge-file-reader-drifted', {
    'bridge-reader.ts': CANONICAL,
    'lib/hardened-json-file.ts': CANONICAL_FILE_READER + '\n// local tweak\n',
    'bridge.ts': wrapper,
  });
  make('missing-file-reader', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper }, { withSibling: false });
  make('symlinked-copy', { 'bridge.ts': wrapper, 'hardened-json-file.ts': CANONICAL_FILE_READER, 'real/bridge-reader.ts': CANONICAL });
  // A drifted copy behind a symlinked folder: src/lib is a link, and src itself is a link.
  make('linked-folder', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
  const drifted = CANONICAL + '\n// local tweak\n';
  for (const sub of ['lib', 'src']) {
    mkdirSync(join(outside, sub), { recursive: true });
    writeFileSync(join(outside, sub, 'bridge-reader.ts'), drifted);
    writeFileSync(join(outside, sub, 'hardened-json-file.ts'), CANONICAL_FILE_READER);
  }
  writeFileSync(join(outside, 'src', 'bridge.ts'), wrapper);
  mkdirSync(join(tmp, 'linked-src'));
  // A folder link named like a shared file, a dangling link, a linked connector folder, src/ linked
  // to a file, and a link to itself.
  make('linked-named-copy', { 'bridge.ts': wrapper, 'hardened-json-file.ts': CANONICAL_FILE_READER });
  make('dangling-link', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
  mkdirSync(join(outside, 'named'));
  writeFileSync(join(outside, 'named', 'bridge-reader.ts'), drifted);
  mkdirSync(join(outside, 'connector', 'src'), { recursive: true });
  writeFileSync(join(outside, 'connector', 'src', 'bridge-reader.ts'), drifted);
  writeFileSync(join(outside, 'file'), 'not a folder\n');
  mkdirSync(join(tmp, 'file-src'));
  make('loop-link', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
  // Windows without Developer Mode cannot make symlinks; those legs are then skipped, said aloud.
  let canSymlink = true;
  try {
    symlinkSync(join(tmp, 'symlinked-copy', 'src', 'real', 'bridge-reader.ts'), join(tmp, 'symlinked-copy', 'src', 'bridge-reader.ts'));
    symlinkSync(join(outside, 'lib'), join(tmp, 'linked-folder', 'src', 'lib'), 'dir');
    symlinkSync(join(outside, 'src'), join(tmp, 'linked-src', 'src'), 'dir');
    symlinkSync(join(outside, 'named'), join(tmp, 'linked-named-copy', 'src', 'bridge-reader.ts'), 'dir');
    symlinkSync(join(outside, 'missing'), join(tmp, 'dangling-link', 'src', 'lib'), 'dir');
    symlinkSync(join(outside, 'connector'), join(tmp, 'linked-connector'), 'dir');
    symlinkSync(join(outside, 'file'), join(tmp, 'file-src', 'src'));
    symlinkSync(join(tmp, 'loop-link', 'src', 'lib'), join(tmp, 'loop-link', 'src', 'lib'));
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    canSymlink = false;
    console.log('check-bridge-reader: cannot create symlinks here (EPERM); skipping the symlink legs');
  }
  make('test-only-mention', { 'server.ts': 'export const x = 1;\n', 'server.test.ts': unsafe });

  const legs = [
    ['identical copy, sent through postToBridge', 'compliant', true],
    ['env vars documented in whole-line comments', 'comment-mention', true],
    ['env read after a block comment on the same line', 'after-block-comment', false],
    ['raw read through the exported bridgeStatePath', 'low-level-export', false],
    ['env read after a // inside a string', 'slashes-in-string', false],
    ['low-level read in a generator method (a line starting *)', 'generator-method', false],
    ['env read interpolated on a template line starting //', 'template-interpolation', false],
    ['env read after a regex holding an escaped /', 'after-regex', false],
    ['env read after a regex holding /*', 'regex-class', false],
    ['env read after a regex holding a quote', 'regex-quote', false],
    ['postToBridge imported and re-exported, never called', 'import-only', false],
    ['postToBridge called only in a comment', 'comment-call', false],
    ['copy vendored but postToBridge never called', 'unused-copy', false],
    ['unhardened reader, not baselined', 'unhardened', false],
    ['unhardened reader, baselined', 'gapped', true],
    ['compliant but still baselined (ratchet)', 'fixed-but-baselined', false],
    ['drifted copy', 'drifted', false],
    ['drifted copy in a subfolder fails even when baselined', 'drifted-baselined', false],
    ['identical copy plus a second reader', 'copy-plus-bypass', false],
    ['identical copy plus a bracket-key env read', 'bracket-bypass', false],
    ['no bridge at all', 'no-bridge', true],
    ['identical file-reader copy, no bridge', 'file-reader-only', true],
    ['drifted file-reader copy, no bridge', 'file-reader-drifted', false],
    ['drifted file-reader copy in a subfolder beside a compliant bridge reader', 'bridge-file-reader-drifted', false],
    ['compliant bridge reader without its hardened-json-file.ts', 'missing-file-reader', false],
    ['env var only in a test file', 'test-only-mention', true],
    ...(canSymlink
      ? [
          ['copy that is a symlink, even to an identical file', 'symlinked-copy', false],
          ['drifted copy behind a symlinked folder under src/', 'linked-folder', false],
          ['src/ itself a symlink, to a drifted copy', 'linked-src', false],
          ['folder link named like a shared file', 'linked-named-copy', false],
          ['dangling link beside a compliant copy', 'dangling-link', false],
          ['connector folder that is a symlink', 'linked-connector', false],
          ['src/ a symlink to a file', 'file-src', false],
          ['a link to itself beside a compliant copy', 'loop-link', false],
        ]
      : []),
  ];
  let failures = 0;
  let checked = 0;
  const check = (label, pass) => {
    checked += 1;
    if (!pass) failures += 1;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${label}`);
  };
  try {
    console.log('check-bridge-reader: self-test (synthetic fixtures)');
    for (const [label, connector, expectOk] of legs) {
      const { ok, message } = evaluateConnector(connector);
      const pass = ok === expectOk;
      if (!pass) failures += 1;
      console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${label} (expected ${expectOk ? 'PASS' : 'FAIL'})\n    ${message.split('\n')[0]}`);
    }
    // The generator repairs a drifted copy, after which the connector passes and a second run writes nothing.
    const driftedCopies = () => copiesIn(join(tmp, 'drifted', 'src'));
    check('sync-shared-sources rewrites a drifted copy', sync(driftedCopies()).length === 1);
    check('the repaired connector passes', evaluateConnector('drifted').ok);
    check('a second sync-shared-sources run writes nothing', sync(driftedCopies()).length === 0);
    // Every link is reported and left alone: nothing behind one is written, and no link is replaced.
    if (canSymlink) {
      const links = connectorCopies(tmp).filter((c) => c.link);
      const expected = [
        join('dangling-link', 'src', 'lib'),
        join('file-src', 'src'),
        'linked-connector',
        join('linked-folder', 'src', 'lib'),
        join('linked-named-copy', 'src', 'bridge-reader.ts'),
        join('linked-src', 'src'),
        join('loop-link', 'src', 'lib'),
        join('symlinked-copy', 'src', 'bridge-reader.ts'),
      ].sort();
      const found = links.map((c) => relative(tmp, c.path)).sort();
      check(`sync-shared-sources reports every link (found: ${found.join(', ')})`, JSON.stringify(found) === JSON.stringify(expected));
      check('sync-shared-sources writes nothing for a link', sync(links).length === 0);
      check(
        'nothing behind a link changed',
        ['lib', 'src', 'named', join('connector', 'src')].every((sub) => readFileSync(join(outside, sub, 'bridge-reader.ts'), 'utf8') === drifted) &&
          readFileSync(join(tmp, 'symlinked-copy', 'src', 'real', 'bridge-reader.ts'), 'utf8') === CANONICAL,
      );
      check('every link is still a link', expected.every((p) => lstatSync(join(tmp, p)).isSymbolicLink()));
    }
    check('--all reports a baselined connector that does not exist', sweep().lines.some((l) => l.startsWith('check-bridge-reader: gone — baselined but no such connector')));
    const growth = grownEntries(['a', 'b', 'new'], ['a', 'b', 'c']);
    const shrinkOk = grownEntries(['a'], ['a', 'b']).length === 0;
    check('--base flags an added baseline entry and allows removals', growth.length === 1 && growth[0] === 'new' && shrinkOk);
    // baseBaseline against a fake git: the file absent, readable, or present but unreadable.
    const fakeGit = (show) => (args) => {
      if (args[0] === 'rev-parse') return 'abc\n';
      if (args[0] === 'ls-tree') return show === undefined ? '' : 'bridge-reader-baseline.json\n';
      if (show instanceof Error) throw show;
      return show;
    };
    const baseLegs = [
      ['absent at the base: first change, no shrink check', fakeGit(undefined), (r) => r === null],
      ['readable at the base', fakeGit('{"gappedConnectors":["a"]}'), (r) => Array.isArray(r) && r[0] === 'a'],
      ['present but its blob cannot be fetched: refused', fakeGit(new Error('missing blob')), 'throws'],
      ['present but malformed: refused', fakeGit('{"gapped'), 'throws'],
    ];
    for (const [label, run, expect] of baseLegs) {
      let pass;
      try {
        const r = baseBaseline('base', run);
        pass = expect !== 'throws' && expect(r);
      } catch {
        pass = expect === 'throws';
      }
      check(`--base baseline ${label}`, pass);
    }
  } finally {
    ({ connectorsRoot, baseline } = saved);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  const total = legs.length + checked;
  if (failures > 0) {
    console.error(`\ncheck-bridge-reader: SELF-TEST FAILED (${failures}/${total} legs)`);
    return 1;
  }
  console.log(`\ncheck-bridge-reader: self-test PASS (${total}/${total} legs)`);
  return 0;
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/check-bridge-reader.mjs <connector-name> | --all | --self-test');
  process.exit(2);
}
if (arg === '--self-test') process.exit(runSelfTest());
if (arg === '--all') {
  const baseIndex = process.argv.indexOf('--base');
  const baseRef = baseIndex > 0 ? process.argv[baseIndex + 1] : undefined;
  if (baseIndex > 0 && !baseRef) {
    console.error('usage: --base needs a git ref');
    process.exit(2);
  }
  let { connectors, lines, failed } = sweep();
  if (baseRef) {
    let base;
    try {
      base = baseBaseline(baseRef);
    } catch (err) {
      console.error(`check-bridge-reader: ${err.message}`);
      process.exit(2);
    }
    if (base === null) {
      lines.push(`check-bridge-reader: no baseline at ${baseRef} (its first change), so no shrink check`);
    } else {
      for (const c of grownEntries(baseline.gappedConnectors ?? [], base)) {
        lines.push(`check-bridge-reader: ${c} — added to scripts/bridge-reader-baseline.json, which only shrinks: send its bridge requests through the vendored reader instead`);
        failed += 1;
      }
    }
  }
  for (const l of lines) console.log(l);
  console.log(`\ncheck-bridge-reader: swept ${connectors.length} connectors, ${failed} failing`);
  process.exit(failed > 0 ? 1 : 0);
}
const { ok, message } = evaluateConnector(arg);
(ok ? console.log : console.error)(message);
process.exit(ok ? 0 : 1);
