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
//   - it carries a src/bridge-reader.ts that differs from the canonical file
//     (a drifted copy fails even when baselined);
//   - it is compliant but still baselined (ratchet: remove it from the baseline).
// --all also fails a stale baseline entry (no such connector, or it no longer
// reads the bridge), and with --base an entry the base ref's baseline does not
// have. The baseline can therefore only shrink.
//
// This is attention-forcing, not proof: it cannot see an env var read through
// a computed key. The §13 release security review still reads the code.

import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CANONICAL = readFileSync(join(repoRoot, 'test-harness', 'src', 'bridge-reader.ts'), 'utf8');
const ENV_VARS = /\b(?:MCP_HOST_BRIDGE_STATE|MINDSTONE_REBEL_BRIDGE_STATE)\b/;
const BYPASS = /\b(?:MCP_HOST_BRIDGE_STATE|MINDSTONE_REBEL_BRIDGE_STATE|readBridgeState|bridgeStatePath)\b/;
const CALL = /\bpostToBridge\s*\(/;

let connectorsRoot = join(repoRoot, 'connectors');
let baseline = JSON.parse(readFileSync(join(__dirname, 'bridge-reader-baseline.json'), 'utf8'));

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
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
  if (!existsSync(dir)) return { ok: false, readsBridge: false, message: `${tag} — connector directory not found` };
  const files = sourceFiles(join(dir, 'src'));
  const texts = files.map((f) => [f, readFileSync(f, 'utf8')]);
  const readsBridge = texts.some(([, t]) => ENV_VARS.test(t));
  const baselined = (baseline.gappedConnectors ?? []).includes(connector);
  const result = (ok, message) => ({ ok, readsBridge, message: `${tag} ${message}` });

  const copies = texts.filter(([f]) => basename(f) === 'bridge-reader.ts');
  const drifted = copies.filter(([, t]) => t !== CANONICAL);
  if (drifted.length > 0) {
    return result(
      false,
      `— ${drifted.map(([f]) => relative(dir, f)).join(', ')} differs from test-harness/src/bridge-reader.ts.\n` +
        `  Copy the canonical file over it; change the canonical file (and every copy) for a real change.`,
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
      `  Copy test-harness/src/bridge-reader.ts to src/bridge-reader.ts unchanged and send bridge\n` +
      `  requests through its postToBridge (connectors/_template/src/bridge.ts shows how).`,
  );
}

function discoverConnectors() {
  return readdirSync(connectorsRoot)
    .filter((name) => statSync(join(connectorsRoot, name)).isDirectory())
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
  const saved = { connectorsRoot, baseline };
  connectorsRoot = tmp;
  baseline = { gappedConnectors: ['gapped', 'fixed-but-baselined', 'drifted-baselined', 'gone'] };
  const make = (name, files) => {
    for (const [rel, text] of Object.entries(files)) {
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
  make('compliant', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper });
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
  make('drifted-baselined', { 'lib/bridge-reader.ts': CANONICAL.replace('O_NOFOLLOW', 'O_RDONLY'), 'bridge.ts': unsafe });
  make('copy-plus-bypass', { 'bridge-reader.ts': CANONICAL, 'bridge.ts': wrapper, 'auth.ts': unsafe });
  make('bracket-bypass', { 'bridge-reader.ts': CANONICAL, 'auth.ts': `const p = process.env['MINDSTONE_REBEL_BRIDGE_STATE'];\n` });
  make('no-bridge', { 'server.ts': `export const x = fetch('https://example.com');\n` });
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
    ['env var only in a test file', 'test-only-mention', true],
  ];
  let failures = 0;
  try {
    console.log('check-bridge-reader: self-test (synthetic fixtures)');
    for (const [label, connector, expectOk] of legs) {
      const { ok, message } = evaluateConnector(connector);
      const pass = ok === expectOk;
      if (!pass) failures += 1;
      console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${label} (expected ${expectOk ? 'PASS' : 'FAIL'})\n    ${message.split('\n')[0]}`);
    }
    const stale = sweep().lines.some((l) => l.startsWith('check-bridge-reader: gone — baselined but no such connector'));
    if (!stale) failures += 1;
    console.log(`  ${stale ? 'PASS' : 'FAIL'} — --all reports a baselined connector that does not exist`);
    const growth = grownEntries(['a', 'b', 'new'], ['a', 'b', 'c']);
    const shrinkOk = grownEntries(['a'], ['a', 'b']).length === 0;
    const growthPass = growth.length === 1 && growth[0] === 'new' && shrinkOk;
    if (!growthPass) failures += 1;
    console.log(`  ${growthPass ? 'PASS' : 'FAIL'} — --base flags an added baseline entry and allows removals`);
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
    for (const [label, run, check] of baseLegs) {
      let pass;
      try {
        const r = baseBaseline('base', run);
        pass = check !== 'throws' && check(r);
      } catch {
        pass = check === 'throws';
      }
      if (!pass) failures += 1;
      console.log(`  ${pass ? 'PASS' : 'FAIL'} — --base baseline ${label}`);
    }
  } finally {
    ({ connectorsRoot, baseline } = saved);
    rmSync(tmp, { recursive: true, force: true });
  }
  const total = legs.length + 6;
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
