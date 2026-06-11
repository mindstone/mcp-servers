#!/usr/bin/env node
// AGENTS.md security invariant #6 coverage gate. Per AGENTS.md, this script
// operates on ONE connector at a time, mirroring check-status.mjs /
// check-server-json.mjs.
//
// Usage:
//   node scripts/check-untrusted-coverage.mjs <connector-name>
//   node scripts/check-untrusted-coverage.mjs --all   # sweep every connector except _template
//
// Exits 0 on pass, non-zero on a NEW gap. See "What this can and cannot prove".
//
// ── What this can and cannot prove ──────────────────────────────────────────
// This is an ATTENTION-FORCING gate, NOT a proof of correctness. It CANNOT know
// which response field is attacker-controlled vs connector-controlled — that is
// not statically visible (a `Description` SDK field and an `Id` SDK field look
// identical to a static scanner). It only enforces a DECISION:
//
//   If a connector talks to an external system (its source references a network
//   client / fetch), then its source MUST do one of:
//     (a) reach the `<untrusted-content>` envelope helper (import the shared
//         test-harness helper, a local untrusted-content module, or otherwise
//         reference the `untrusted-content` envelope), OR
//     (b) carry an explicit `// untrusted-content-exempt: <reason>` marker
//         somewhere in src/ (e.g. "returns only asset URLs / IDs"), OR
//     (c) be listed in scripts/untrusted-coverage-baseline.json under
//         `gappedConnectors` (a KNOWN, tracked gap — FOX-3490 follow-up
//         remediation program), OR under `exemptConnectors` (reviewed and
//         confirmed to return NO model-visible external text — generation
//         connectors returning only IDs / status / asset URLs / binary, or
//         field-allowlisting connectors). `exemptConnectors` is the in-repo
//         equivalent of the per-file `// untrusted-content-exempt:` marker, used
//         where editing the connector's own source is out of scope.
//
// The field-level "is this specific string actually enveloped" judgement stays
// with the human/AI §13 release security review. This gate stops the gapped
// population from GROWING silently, and ratchets the known debt DOWN: a
// baselined connector that later reaches an envelope FAILS the gate, forcing
// its removal from the baseline (so the baseline can never silently mask a
// regression in a connector that was supposedly fixed).
//
// ── Known residual blind spots (egress detection) ──────────────────────────
// Egress detection is heuristic. As of the FOX-3490 sweep it DOES catch:
//   - global `fetch(...)` and common HTTP libs (axios / node-fetch / undici /
//     got / ky / cross-fetch), node `http(s).request/get`, imapflow/nodemailer,
//     Microsoft Graph (`@microsoft/microsoft-graph`, `graph.microsoft.com`),
//     headless browsers (playwright/puppeteer);
//   - the in-repo shared Graph client (`@mindstone/mcp-server-microsoft-shared`,
//     `client.api(...)`, `callGraph(...)`) used by the microsoft-* family;
//   - local subprocess egress (`child_process` / `spawn` / `execFile`) used by
//     apple-shortcuts and browser-automation;
//   - common vendored SDKs already present in this repo (jsforce, xero-node,
//     googleapis, intuit/quickbooks).
// It does NOT model arbitrary new SDKs or bespoke host-bridge channels: a future
// connector that reaches external data through a transport NONE of the above
// patterns name would report "no network-egress signal detected" and pass for
// the WRONG reason. There is no such connector in the repo today (every gapped
// connector now trips a network signal for the RIGHT reason — see the baseline),
// but when adding a connector on a novel transport, add its egress signal here
// (or baseline/exempt it explicitly) rather than relying on silence.
//
// History: docs/plans/260611_fox3490-untrusted-envelopes/ (FOX-3490).

import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The connectors root is normally <repoRoot>/connectors. --self-test points it
// at a temporary synthetic fixture tree so the gate's regression cases can be
// exercised without committing fake connectors.
let connectorsRoot = join(repoRoot, 'connectors');

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

// Source files only — never test files (tests legitimately reference everything).
function connectorSourceFiles(srcDir) {
  return walk(srcDir).filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.js')) &&
      !/\.test\.[jt]s$/.test(f) &&
      !/(\/|\\)(test|__tests__)(\/|\\)/.test(f),
  );
}

// Is this file a vendored/local untrusted-content HELPER IMPLEMENTATION
// (e.g. connectors/<name>/src/untrusted-content.ts or
// .../utils/untrusted-content.ts)? Such a file DECLARES `export function
// wrapUntrusted(...)`, which would otherwise satisfy the envelope-evidence
// regex on its own. A connector that copies `_template` and keeps this file but
// never imports/calls it from real source is NOT enveloped — it just carries
// dead code. We therefore exclude helper-implementation files from the
// envelope-evidence scan and require an envelope import/CALL from NON-helper
// source to count as covered. (We still scan helper files for network signals —
// a helper that itself fetches would legitimately count.)
function isEnvelopeHelperFile(f) {
  return /(?:^|[\\/])untrusted-content\.[jt]s$/.test(f);
}

// Heuristic: does this connector return responses fetched from an external
// system? We look for the common network-egress signals. This is intentionally
// broad (favouring false-positives, cleared by an exempt marker) over
// false-negatives. Connectors that reach external data via the host bridge or
// a local CLI (no network lib visible) are NOT auto-detected here and are
// captured by the baseline instead.
const NETWORK_SIGNALS = [
  /\bfetch\s*\(/, // global fetch
  /from\s+['"](?:axios|node-fetch|undici|got|ky|cross-fetch)['"]/,
  /require\(\s*['"](?:axios|node-fetch|undici|got|ky|cross-fetch)['"]\s*\)/,
  /from\s+['"]imapflow['"]/, // email
  /from\s+['"]nodemailer['"]/,
  /@microsoft\/microsoft-graph|graph\.microsoft\.com/, // microsoft graph
  /from\s+['"](?:playwright|puppeteer)(?:-core)?['"]/, // headless browser
  /\bhttps?\.request\s*\(|\bhttps?\.get\s*\(/, // node http/https
  // In-repo shared Microsoft Graph client (microsoft-* family). These reach
  // external data via the shared client's `client.api(...)` builder and the
  // local `callGraph(...)` wrapper — no direct HTTP lib is visible in the
  // connector's own source, so without these the family reports "no network".
  /from\s+['"]@mindstone\/mcp-server-microsoft-shared['"]/,
  /\bclient\.api\s*\(/, // graph request builder: client.api('/me/messages')
  /\bcallGraph\s*\(/, // the family's shared graph-call wrapper
  // Local subprocess egress (apple-shortcuts: `spawn('shortcuts')`,
  // browser-automation: `execFile` of a CLI that drives the open web). Not a
  // network lib, but it returns arbitrary external/attacker-controllable text.
  /from\s+['"](?:node:)?child_process['"]/,
  /\b(?:spawn|execFile|execFileSync|exec)\s*\(/,
  // Vendored third-party SDKs present in this repo whose client objects fetch
  // remote records (no bare `fetch(` visible at the call site).
  /from\s+['"]jsforce['"]/, // salesforce
  /from\s+['"]xero-node(?:\/[^'"]*)?['"]/, // xero
  /from\s+['"]googleapis['"]/, // google-* SDK surfaces
  /from\s+['"]node-quickbooks['"]/, // quickbooks SDK (where used)
];

function referencesNetwork(text) {
  return NETWORK_SIGNALS.some((re) => re.test(text));
}

// Heuristic: does this connector reach the untrusted-content envelope helper?
// We require an ACTUAL helper reference — an import of an untrusted-content
// module (shared test-harness or a local/vendored copy) or a call to a
// `wrapUntrusted*` function. We deliberately do NOT match a bare
// `untrusted-content` mention in prose/comments: a connector that merely
// *talks about* the envelope in a comment (e.g. a false-safe "the host wraps
// it" claim) is exactly the case this gate must NOT be fooled by.
//
// CRITICAL: this scan runs over NON-HELPER source only. The helper
// implementation file (src/untrusted-content.ts) DECLARES `wrapUntrusted` and
// would self-satisfy these regexes; a `_template`-derived connector that keeps
// the helper file but never imports/calls it would then PASS while returning
// raw external text. Excluding the helper file forces a real import OR call
// from the connector's own code to count as coverage.
const ENVELOPE_SIGNALS = [
  // import / require of an *untrusted-content* module, or of the shared helper package.
  /(?:from|require\(\s*)['"][^'"]*untrusted-content[^'"]*['"]/,
  /(?:from|require\(\s*)['"]@mindstone\/mcp-test-harness['"]/,
  // a call to any wrapUntrusted* helper (wrapUntrusted / wrapUntrustedJsonStrings /
  // wrapUntrustedContent / wrapUntrustedTicketContent / wrapUntrustedEmailBody / …).
  /\bwrapUntrusted[A-Za-z]*\s*\(/,
];

function referencesEnvelope(text) {
  return ENVELOPE_SIGNALS.some((re) => re.test(text));
}

// `// untrusted-content-exempt: <reason>` — case-insensitive, requires a
// non-empty reason after the colon.
const EXEMPT_MARKER = /\/\/\s*untrusted-content-exempt:\s*\S+/i;

function hasExemptMarker(text) {
  return EXEMPT_MARKER.test(text);
}

// Load the baseline of KNOWN, tracked gaps.
const baselinePath = join(__dirname, 'untrusted-coverage-baseline.json');
let baseline = { gappedConnectors: [], exemptConnectors: [] };
if (existsSync(baselinePath)) {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
}
const baselineSet = new Set(baseline.gappedConnectors ?? []);
const exemptSet = new Set(
  Array.isArray(baseline.exemptConnectors)
    ? baseline.exemptConnectors
    : Object.keys(baseline.exemptConnectors ?? {}),
);

// Evaluate one connector. Returns { ok, message } and never exits — the caller
// decides how to aggregate (single-connector vs --all sweep).
function evaluateConnector(connector) {
  const dir = join(connectorsRoot, connector);
  if (!existsSync(dir)) {
    return { ok: false, message: `check-untrusted-coverage: connector directory not found: ${dir}` };
  }

  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) {
    // No source to analyse — nothing to gate.
    return { ok: true, message: `check-untrusted-coverage: ${connector} — no src/ directory; skipping` };
  }

  // Split source into the connector's OWN code vs vendored helper
  // implementation files. Network signals are scanned across ALL source (a
  // helper that itself fetches still counts as egress), but envelope evidence
  // is scanned over NON-helper source ONLY — see ENVELOPE_SIGNALS comment.
  const files = connectorSourceFiles(srcDir);
  const allText = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const nonHelperText = files
    .filter((f) => !isEnvelopeHelperFile(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const network = referencesNetwork(allText);
  const enveloped = referencesEnvelope(nonHelperText);
  const exempt = hasExemptMarker(allText);
  const baselined = baselineSet.has(connector);
  const baselineExempt = exemptSet.has(connector);

  // Config sanity: a connector cannot be both a tracked gap and exempt.
  if (baselined && baselineExempt) {
    return {
      ok: false,
      message:
        `check-untrusted-coverage: ${connector} — listed in BOTH gappedConnectors and ` +
        `exemptConnectors in scripts/untrusted-coverage-baseline.json. Pick one.`,
    };
  }

  // ── Ratchet: a baselined connector that is now enveloped must come OFF the
  // baseline. Otherwise the baseline could silently mask a future regression in
  // a connector everyone believes is fixed.
  if (baselined && enveloped) {
    return {
      ok: false,
      message:
        `check-untrusted-coverage: ${connector} — now reaches the untrusted-content envelope ` +
        `but is still listed in scripts/untrusted-coverage-baseline.json as a known gap.\n` +
        `  Remove "${connector}" from gappedConnectors in that baseline file (ratchet-down).`,
    };
  }

  if (!network) {
    // Doesn't appear to touch the network — no external responses to envelope.
    return { ok: true, message: `check-untrusted-coverage: ${connector} OK (no network-egress signal detected)` };
  }

  if (enveloped) {
    return { ok: true, message: `check-untrusted-coverage: ${connector} OK (reaches untrusted-content envelope)` };
  }

  if (exempt) {
    return {
      ok: true,
      message: `check-untrusted-coverage: ${connector} OK (// untrusted-content-exempt marker present)`,
    };
  }

  if (baselineExempt) {
    return {
      ok: true,
      message:
        `check-untrusted-coverage: ${connector} OK (exempt in baseline — reviewed, returns no ` +
        `model-visible external text)`,
    };
  }

  if (baselined) {
    return {
      ok: true,
      message:
        `check-untrusted-coverage: ${connector} OK (baselined known gap — tracked in ` +
        `scripts/untrusted-coverage-baseline.json, FOX-3490 follow-up)`,
    };
  }

  // New, unenveloped, network-touching connector with no exempt marker and not
  // baselined → fail closed.
  return {
    ok: false,
    message:
      `check-untrusted-coverage: ${connector} — FAILS invariant #6 coverage gate.\n` +
      `  This connector references a network client / fetch (so it can return external\n` +
      `  text), but its src/ does NOT reach the <untrusted-content> envelope helper and\n` +
      `  carries no exempt marker.\n` +
      `  Choose ONE:\n` +
      `    1. Wrap external-text fields with the shared helper:\n` +
      `         import { wrapUntrusted } from '@mindstone/mcp-test-harness';\n` +
      `       (or a vendored local untrusted-content module, as in connectors/_template).\n` +
      `    2. If this connector genuinely returns NO model-visible external text (only\n` +
      `       IDs / status / asset URLs / binary), add a one-line marker in src/:\n` +
      `         // untrusted-content-exempt: <reason>\n` +
      `  See AGENTS.md security invariant #6 and docs-private/security/ §13.`,
  };
}

// Discover every connector directory except `_template` (the scaffold).
function discoverConnectors() {
  return readdirSync(connectorsRoot)
    .filter((name) => {
      if (name === '_template') return false;
      const full = join(connectorsRoot, name);
      return statSync(full).isDirectory();
    })
    .sort();
}

// ── Self-test: prove the gate's load-bearing behaviours against synthetic
// fixtures. The critical case (F1 regression) is "fetch + an UNUSED vendored
// untrusted-content helper + raw result" — this MUST fail, because before the
// helper-file exclusion the gate counted the helper's own `wrapUntrusted`
// declaration as coverage and false-passed exactly this connector shape.
function writeFixtureFile(srcDir, name, contents) {
  writeFileSync(join(srcDir, name), contents);
}

// A faithful copy of the wrapUntrusted helper declaration, so the synthetic
// helper file matches the real `connectors/_template/src/untrusted-content.ts`
// signal surface (this is what used to self-satisfy the envelope scan).
const HELPER_FILE_CONTENTS = `
export function wrapUntrusted(text, source) {
  if (text == null) return text;
  return '<untrusted-content source="' + source + '">' + text + '</untrusted-content>';
}
`;

function makeFixtureConnector(root, name, files) {
  const srcDir = join(root, name, 'src');
  mkdirSync(srcDir, { recursive: true });
  for (const [fname, contents] of Object.entries(files)) {
    writeFixtureFile(srcDir, fname, contents);
  }
}

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'untrusted-coverage-selftest-'));
  const prevRoot = connectorsRoot;
  connectorsRoot = tmp;
  const legs = [];
  function leg(label, connector, expectOk) {
    const { ok, message } = evaluateConnector(connector);
    const pass = ok === expectOk;
    legs.push({ label, connector, expectOk, gotOk: ok, pass, message });
    console.log(
      `  ${pass ? 'PASS' : 'FAIL'} — ${label} (expected ${expectOk ? 'PASS' : 'FAIL'}, ` +
        `got ${ok ? 'PASS' : 'FAIL'})\n    ${message.split('\n')[0]}`,
    );
  }
  try {
    console.log('check-untrusted-coverage: self-test (synthetic fixtures)');

    // F1 regression: fetch + UNUSED vendored helper file + raw result → must FAIL.
    makeFixtureConnector(tmp, 'fox3490-fetch-unused-helper', {
      'untrusted-content.ts': HELPER_FILE_CONTENTS,
      'server.ts': `
        export async function listThings() {
          const res = await fetch('https://example.com/things');
          const data = await res.json();
          // NOTE: returns raw external text — never calls wrapUntrusted.
          return { content: [{ type: 'text', text: data.description }] };
        }
      `,
    });
    leg('fetch + unused vendored helper + raw result must FAIL', 'fox3490-fetch-unused-helper', false);

    // Positive control A: fetch + helper file + an ACTUAL call from server → PASS.
    makeFixtureConnector(tmp, 'fox3490-fetch-enveloped', {
      'untrusted-content.ts': HELPER_FILE_CONTENTS,
      'server.ts': `
        import { wrapUntrusted } from './untrusted-content.js';
        export async function listThings() {
          const res = await fetch('https://example.com/things');
          const data = await res.json();
          return { content: [{ type: 'text', text: wrapUntrusted(data.description, 'demo') }] };
        }
      `,
    });
    leg('fetch + helper imported & called from server must PASS', 'fox3490-fetch-enveloped', true);

    // Positive control B: no egress at all → PASS (nothing external to envelope).
    makeFixtureConnector(tmp, 'fox3490-no-network', {
      'server.ts': `
        export async function echo(msg) {
          return { content: [{ type: 'text', text: 'pong: ' + msg }] };
        }
      `,
    });
    leg('no network egress must PASS', 'fox3490-no-network', true);

    // Egress-broadening control: shared Microsoft Graph client (no bare fetch) +
    // raw result, NOT baselined → must FAIL (proves the F3 signal fires).
    makeFixtureConnector(tmp, 'fox3490-graph-raw', {
      'client.ts': `import { type Client } from '@mindstone/mcp-server-microsoft-shared';`,
      'mail.ts': `
        export async function listMail(client) {
          const res = await client.api('/me/messages').get();
          return { content: [{ type: 'text', text: res.value[0].subject }] };
        }
      `,
    });
    leg('shared Graph client + raw result (not baselined) must FAIL', 'fox3490-graph-raw', false);

    // Egress-broadening control: subprocess egress + raw result, NOT baselined → FAIL.
    makeFixtureConnector(tmp, 'fox3490-subprocess-raw', {
      'index.ts': `
        import { spawn } from 'child_process';
        export async function runShortcut(name) {
          const proc = spawn('shortcuts', [name]);
          return { content: [{ type: 'text', text: String(proc.stdout) }] };
        }
      `,
    });
    leg('subprocess egress + raw result (not baselined) must FAIL', 'fox3490-subprocess-raw', false);

    const failures = legs.filter((l) => !l.pass);
    if (failures.length > 0) {
      console.error(`\ncheck-untrusted-coverage: SELF-TEST FAILED (${failures.length}/${legs.length} legs)`);
      return 1;
    }
    console.log(`\ncheck-untrusted-coverage: self-test PASS (${legs.length}/${legs.length} legs)`);
    return 0;
  } finally {
    connectorsRoot = prevRoot;
    rmSync(tmp, { recursive: true, force: true });
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/check-untrusted-coverage.mjs <connector-name> | --all | --self-test');
  process.exit(2);
}

if (arg === '--self-test') {
  process.exit(runSelfTest());
}

if (arg === '--all') {
  const connectors = discoverConnectors();
  let failed = 0;
  for (const c of connectors) {
    const { ok, message } = evaluateConnector(c);
    console.log(message);
    if (!ok) failed += 1;
  }
  console.log(`\ncheck-untrusted-coverage: swept ${connectors.length} connectors, ${failed} failing`);
  process.exit(failed > 0 ? 1 : 0);
}

const { ok, message } = evaluateConnector(arg);
(ok ? console.log : console.error)(message);
process.exit(ok ? 0 : 1);
