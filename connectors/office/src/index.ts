#!/usr/bin/env node
// @ts-nocheck
/* eslint-disable */
/*
 * Lift-and-shift port of resources/mcp/rebel-office/server.cjs (CJS → ESM).
 * Tool handler logic is intentionally byte-equivalent to the Rebel in-repo version.
 * Type-checking is disabled here because this file is a hand-rolled shim around
 * the MCP SDK; the public surface is the registered tool names + their JSON
 * schemas, which are covered by the managed-install smoke test rather than by
 * TS types. Do NOT refactor to `McpServer` + Zod patterns — see planning doc
 * `260422_rebeloffice_oss_migration.md` Stage 1 gotcha #2.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single source of truth for the server-reported version — a hardcoded
// literal here drifted a full release behind package.json once already.
// dist/index.js and src/index.ts both resolve '../package.json' to the
// connector root.
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch (err) {
    console.error('[RebelOffice] Could not read package.json for server version:', err?.message ?? err);
    return 'unknown';
  }
})();

// The sidecar uses HTTPS with a trusted localhost cert (via office-addin-dev-certs).
// Office requires HTTPS for SourceLocation URLs. Since this MCP process connects
// to the same-machine sidecar, we skip cert verification to avoid trust issues
// when the CA hasn't been installed yet — but ONLY for loopback connections.
//
// SECURITY (M3.1, VAL-OFFICE-001..003): the previous implementation flipped
// the Node global TLS-bypass env var process-wide, which would disable
// certificate validation for every HTTPS request issued by this Node process
// (including unrelated outbound calls another connector might make if loaded
// into the same process). We now scope the relaxation to a dedicated
// `https.Agent` that is ONLY attached to requests whose hostname is loopback
// (`127.0.0.1`, `::1`, or `localhost`). Non-loopback HTTPS requests honour
// standard certificate validation.
const loopbackHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const isLoopbackHostname = (hostname) => {
  if (!hostname) return false;
  // Strip surrounding brackets that `URL.hostname` already removes for IPv6,
  // but defend in case a caller passes a raw `[::1]`.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
};

/**
 * Loopback-only HTTPS helper used by the office connector to talk to its
 * sidecar over the office-addin dev cert. For loopback hostnames the dedicated
 * `loopbackHttpsAgent` (rejectUnauthorized: false) is attached; for any other
 * hostname the default agent is used so standard certificate validation
 * applies. The shape is fetch-like so existing call sites can swap in with
 * minimal churn.
 */
const loopbackHttpsRequest = (url, init = {}) => {
  const u = new URL(url);
  if (u.protocol !== 'https:') {
    return Promise.reject(new Error(`loopbackHttpsRequest requires https: URL, got ${u.protocol}`));
  }
  const hostname = u.hostname;
  const agent = isLoopbackHostname(hostname) ? loopbackHttpsAgent : undefined;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: init.method ?? 'GET',
      headers: init.headers,
      agent,
    };
    if (typeof init.lookup === 'function') {
      // Test-only DNS override; production callers never set this.
      requestOptions.lookup = init.lookup;
    }

    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const body = buffer.toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          json: async () => JSON.parse(body),
          text: async () => body,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) {
      req.write(init.body);
    }
    req.end();
  });
};

// ---------------------------------------------------------------------------
// Sidecar state — discover the Office sidecar via state file
// ---------------------------------------------------------------------------

const stateFilePath = process.env.MCP_OFFICE_SIDECAR_STATE;
const stateDir = stateFilePath ? path.dirname(stateFilePath) : null;
const lastFailureFilePath = stateDir ? path.join(stateDir, 'sidecar-last-failure.json') : null;

const loadSidecarState = () => {
  if (!stateFilePath) return null;
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
};

const loadLastFailureState = () => {
  if (!lastFailureFilePath) return null;
  try {
    const raw = fs.readFileSync(lastFailureFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.code !== 'string' || !Number.isInteger(parsed.at) || parsed.at <= 0) {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error('[office-sidecar] failed to read sidecar-last-failure.json', err && err.message);
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// Lazy sidecar lifecycle — prefer existing main-process-owned sidecar; lazy-
// spawn as a fallback safety net
// ---------------------------------------------------------------------------

let sidecarChild: import('node:child_process').ChildProcess | null = null;
let sidecarStarting = null; // Promise<SidecarState | undefined> while sidecar is booting
let beforeLockedStateCheckForTests = null;

// Filesystem-level lock path. Used as a belt-and-suspenders guard against
// duplicate spawns (in addition to the in-process `sidecarStarting` promise).
const lockFilePath = stateDir ? path.join(stateDir, 'sidecar.lock') : null;

const readLockPid = () => {
  if (!lockFilePath) return null;
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanupLock = () => {
  if (!lockFilePath) return;
  try { fs.unlinkSync(lockFilePath); } catch { /* ignore */ }
};

const cleanupLastFailureFile = () => {
  if (!lastFailureFilePath) return;
  try { fs.unlinkSync(lastFailureFilePath); } catch { /* ignore */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the sidecar state file to appear AND reference a live PID.
 * Returns the parsed state or null if the timeout elapses.
 */
const waitForState = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = loadSidecarState();
    if (lastState && isPidAlive(lastState.pid)) {
      return lastState;
    }
    await sleep(100);
  }
  return lastState;
};

/**
 * Verify the sidecar is actually responding on its declared port.
 * Protects against state-file-exists-but-server-not-yet-listening races.
 */
const checkSidecarHealth = (state, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  const req = https.request({
    hostname: '127.0.0.1',
    port: state.port,
    path: '/health',
    method: 'GET',
    rejectUnauthorized: false,
  }, (res) => {
    res.resume();
    res.on('end', () => {
      settle({
        ok: res.statusCode === 200,
        reason: res.statusCode === 200 ? 'ok' : 'non-200',
      });
    });
  });

  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error('Sidecar health check timed out.'));
    settle({ ok: false, reason: 'timeout' });
  });
  req.on('error', () => {
    settle({ ok: false, reason: 'request-error' });
  });
  req.end();
});

const pingSidecar = async (state, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkSidecarHealth(
      state,
      Math.min(2_000, Math.max(deadline - Date.now(), 1)),
    );
    if (health.ok) {
      return true;
    }
    await sleep(100);
  }
  return false;
};

const createKillSwitchError = () => {
  const error = new Error('The Office connection has been turned off for this Rebel installation.');
  error.code = 'kill-switch';
  return error;
};

const getFallbackReasonForHealthCheck = (health) => (
  health.reason === 'timeout' ? 'health-timeout' : 'health-non-200'
);

const evaluateExistingSidecar = async (state, pidDeadReason) => {
  if (!state) {
    return { state: null, fallbackReason: 'no-state-file' };
  }

  if (state.pid === process.pid) {
    return { state: null, fallbackReason: 'same-process-stale-pid' };
  }

  if (!isPidAlive(state.pid)) {
    return { state: null, fallbackReason: pidDeadReason };
  }

  const health = await checkSidecarHealth(state, 2_000);
  if (health.ok) {
    return { state, fallbackReason: null };
  }

  return {
    state: null,
    fallbackReason: getFallbackReasonForHealthCheck(health),
  };
};

const readLastEagerStartErrorCode = (fallbackState = null) => {
  const fallbackCode = fallbackState && typeof fallbackState.lastEagerStartErrorCode === 'string'
    ? fallbackState.lastEagerStartErrorCode
    : null;
  if (!stateFilePath) {
    return loadLastFailureState()?.code ?? fallbackCode;
  }
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.lastEagerStartErrorCode === 'string'
      ? parsed.lastEagerStartErrorCode
      : fallbackCode;
  } catch {
    return loadLastFailureState()?.code ?? fallbackCode;
  }
};

const writeFallbackInvokedSentinel = ({ lastEagerStartErrorCode, reason }) => {
  process.stderr.write(`${JSON.stringify({
    event: 'office-sidecar.fallback-invoked',
    reason,
    lastEagerStartErrorCode,
    pid: process.pid,
    at: Date.now(),
  })}\n`);
};

// Resolve the sidecar CLI relative to the compiled server entrypoint. This file
// ships as `dist/index.js` in the published package and expects the sidecar at
// `dist/sidecar/cli.js` (produced by `npm run build:sidecar`).
//
// During in-tree development (running from `src/` via tsx/ts-node before
// `npm run build`), we also check the local `dist/sidecar/cli.js` path so you
// can rebuild the sidecar independently from the server. There is no
// monorepo-wide fallback here — this package is standalone.
const resolveSidecarScript = () => {
  const packagedPath = path.join(__dirname, 'sidecar', 'cli.js');
  if (fs.existsSync(packagedPath)) return packagedPath;

  // Dev path — in-tree when running pre-build from src/
  const packageRoot = path.resolve(__dirname, '..');
  const devPath = path.join(packageRoot, 'dist', 'sidecar', 'cli.js');
  if (fs.existsSync(devPath)) return devPath;

  return null;
};

const resolveAddinDir = () => {
  const packagedPath = path.join(__dirname, 'addin');
  if (fs.existsSync(packagedPath)) return packagedPath;

  const packageRoot = path.resolve(__dirname, '..');
  const devPath = path.join(packageRoot, 'dist', 'addin');
  if (fs.existsSync(devPath)) return devPath;

  return null;
};

/**
 * Run the actual spawn + startup flow. Caller MUST hold the file lock.
 * Resolves once the state file is visible AND the sidecar responds to /health.
 */
const defaultSpawnSidecarAndWait = async () => {
  const script = resolveSidecarScript();
  if (!script) {
    const attempted = [
      path.join(__dirname, 'sidecar', 'cli.js'),
      path.join(path.resolve(__dirname, '..'), 'dist', 'sidecar', 'cli.js'),
    ].join(', ');
    throw new Error(
      `Sidecar script not found (looked in: ${attempted}). Run \`npm run build\` in this package.`,
    );
  }

  if (!stateDir) {
    throw new Error('MCP_OFFICE_SIDECAR_STATE env not set — cannot determine state directory.');
  }

  fs.mkdirSync(stateDir, { recursive: true });

  await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MCP_OFFICE_SIDECAR_STATE_DIR: stateDir,
    };
    const addinDir = resolveAddinDir();
    if (addinDir) env.MCP_OFFICE_ADDIN_DIR = addinDir;

    const child = spawn(process.execPath, [script], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    sidecarChild = child;
    let stdoutBuf = '';
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.includes('\n')) {
        settle(resolve);
      }
    });

    child.stderr.on('data', (chunk) => {
      // Suppress cert-trust noise from office-addin-dev-certs
      const msg = chunk.toString();
      if (!msg.includes('trusted access') && !msg.includes('Certificate:') && !msg.includes('Key:')) {
        process.stderr.write(chunk);
      }
    });

    // Always kill the spawned child on startup failure or timeout. Without this,
    // an orphan can keep running, write state, and bind to fallback ports — leaving
    // the next ensureSidecar() call to potentially adopt a sidecar of unknown vintage.
    const killChildIfAlive = () => {
      try { if (!child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
    };

    child.on('error', (err) => {
      sidecarChild = null;
      killChildIfAlive();
      settle(reject, err);
    });

    child.on('exit', (code) => {
      sidecarChild = null;
      settle(reject, new Error(`Sidecar exited during startup (code=${code})`));
    });

    // Timeout after 30s
    setTimeout(() => {
      killChildIfAlive();
      settle(reject, new Error('Sidecar startup timed out after 30s'));
    }, 30_000);
  });

  // Stdout '\n' means the CLI printed its ready JSON — state file IS written by now,
  // but add a short bounded wait + HTTP ping to defend against any residual races.
  const state = await waitForState(5_000);
  if (!state) {
    throw new Error('Sidecar started but state file did not become readable in time.');
  }

  const reachable = await pingSidecar(state, 5_000);
  if (!reachable) {
    throw new Error(`Sidecar state file points to port ${state.port} but /health is not responding.`);
  }

  cleanupLastFailureFile();
};

let spawnSidecarAndWait = defaultSpawnSidecarAndWait;

const ensureSidecar = async () => {
  // Honor both new (MCP_OFFICE_SIDECAR_DISABLE) and legacy (REBEL_DISABLE_OFFICE_SIDECAR)
  // kill-switch env vars. Legacy support exists so v0.1.1 → v0.1.3 upgrades don't silently
  // ignore an existing operator-set kill-switch (security override). Slated for removal once
  // the legacy name is confirmed unused in the field.
  const newKillSwitch = process.env.MCP_OFFICE_SIDECAR_DISABLE === '1';
  const legacyKillSwitch = process.env.REBEL_DISABLE_OFFICE_SIDECAR === '1';
  if (newKillSwitch || legacyKillSwitch) {
    if (legacyKillSwitch && !newKillSwitch) {
      // Dev-side log only — must NOT leak env var name into user-visible error message.
      process.stderr.write(
        '[office-mcp] Legacy kill-switch env detected (deprecated); please migrate to the documented current name.\n',
      );
    }
    throw createKillSwitchError();
  }

  // Fast path: state file exists, PID alive, and /health responds.
  const existing = loadSidecarState();
  let fallbackReason = 'no-state-file';
  const existingState = await evaluateExistingSidecar(existing, 'pid-dead');
  if (existingState.state) {
    return existingState.state;
  }
  fallbackReason = existingState.fallbackReason ?? fallbackReason;

  // Stale state file — clean up before proceeding.
  if (existing) {
    try { fs.unlinkSync(stateFilePath); } catch { /* ignore */ }
  }

  // Same-process guard: an earlier caller is already in the critical section.
  if (sidecarStarting) {
    return await sidecarStarting;
  }

  if (!stateDir || !lockFilePath) {
    throw new Error('MCP_OFFICE_SIDECAR_STATE env not set — cannot determine state directory.');
  }

  fs.mkdirSync(stateDir, { recursive: true });

  // Critical section — held for the entire spawn + verification.
  // `sidecarStarting` is cleared inside a `finally` so a failed boot doesn't
  // leave the guard permanently set.
  sidecarStarting = (async () => {
    let lastEagerStartErrorCode = readLastEagerStartErrorCode(existing);

    // Acquire the filesystem lock atomically. `wx` fails if the file exists.
    // We loop in case a previous holder died without cleaning up.
    let lockHeld = false;
    const lockDeadline = Date.now() + 30_000;
    while (!lockHeld && Date.now() < lockDeadline) {
      try {
        fs.writeFileSync(lockFilePath, String(process.pid), { flag: 'wx' });
        lockHeld = true;
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          const holderPid = readLockPid();
          if (holderPid && isPidAlive(holderPid) && holderPid !== process.pid) {
            // Another process is mid-spawn. Wait for its state file.
            const state = await waitForState(5_000);
            if (state && state.pid !== process.pid && isPidAlive(state.pid)) {
              const health = await checkSidecarHealth(state, 2_000);
              if (health.ok) {
                return state; // Other spawn succeeded — nothing more to do.
              }
            }
            // Still waiting — loop and re-check the lock.
            continue;
          }
          // Stale lock (holder dead or same PID from an earlier failed attempt).
          cleanupLock();
          continue;
        }
        throw err;
      }
    }

    if (!lockHeld) {
      throw new Error('Timed out waiting to acquire sidecar lock.');
    }

    try {
      // Re-check state under the lock — another caller may have finished
      // spawning between our fast-path check and our lock acquisition.
      if (beforeLockedStateCheckForTests) {
        await beforeLockedStateCheckForTests();
      }
      const current = loadSidecarState();
      lastEagerStartErrorCode = readLastEagerStartErrorCode(current) ?? lastEagerStartErrorCode;
      if (current) {
        const currentState = await evaluateExistingSidecar(current, 'pid-dead-under-lock');
        if (currentState.state) {
          return currentState.state;
        }
        fallbackReason = currentState.fallbackReason ?? fallbackReason;
        try { fs.unlinkSync(stateFilePath); } catch { /* ignore */ }
      }

      writeFallbackInvokedSentinel({
        lastEagerStartErrorCode,
        reason: fallbackReason,
      });
      await spawnSidecarAndWait();
      return loadSidecarState();
    } finally {
      cleanupLock();
    }
  })();

  try {
    return await sidecarStarting;
  } finally {
    sidecarStarting = null;
  }
};

// Clean up sidecar on MCP server exit
process.on('exit', () => {
  cleanupLock();
  if (sidecarChild) {
    try { sidecarChild.kill('SIGTERM'); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Sidecar HTTP bridge helper
// ---------------------------------------------------------------------------

const sidecarRequest = async (app, action, params = {}) => {
  // Lazy-start the sidecar on first use
  try {
    await ensureSidecar();
  } catch (err) {
    return {
      success: false,
      error: `Failed to start Office sidecar: ${err.message}`,
      code: 'SIDECAR_NOT_RUNNING',
    };
  }

  let state = loadSidecarState();
  if (!state) {
    return {
      success: false,
      error: "The Office sidecar started but state file not found. Try again.",
      code: 'SIDECAR_NOT_RUNNING',
    };
  }

  const makeRequest = async (token) => {
    const url = `https://127.0.0.1:${state.port}/${app}/${action}`;
    // Use the loopback-scoped HTTPS helper rather than global fetch so the
    // dev-cert relaxation is per-request and only effective for loopback hosts.
    const response = await loopbackHttpsRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
    });
    return response;
  };

  try {
    let response = await makeRequest(state.token);

    // Re-read state file on 401 — sidecar may have restarted with a new token
    if (response.status === 401) {
      state = loadSidecarState();
      if (!state) {
        return {
          success: false,
          error: "The Office connection isn't running. Start it from Settings → Connectors → Microsoft Office.",
          code: 'SIDECAR_NOT_RUNNING',
        };
      }
      response = await makeRequest(state.token);
    }

    if (!response.ok) {
      // The error body is authored by the sidecar (or an add-in relayed through
      // it) — external, attacker-influenced text. Stamp it so `toMcpResult`
      // wraps it in the untrusted-content envelope instead of emitting it
      // verbatim (AGENTS.md security invariant #6).
      let detail;
      try {
        const payload = await response.json();
        if (typeof payload?.error === 'string') detail = payload.error;
      } catch {
        const body = await response.text();
        if (body) detail = body;
      }
      return stampUntrustedSource({
        success: false,
        error: detail || `Office sidecar request failed (HTTP ${response.status}).`,
        code: 'SIDECAR_ERROR',
      }, app);
    }

    return stampUntrustedSource(await response.json(), app);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        success: false,
        error: "The Office connection isn't running. Start it from Settings → Connectors → Microsoft Office.",
        code: 'SIDECAR_NOT_RUNNING',
      };
    }
    return {
      success: false,
      error: `Failed to reach Office sidecar: ${msg}`,
      code: 'SIDECAR_ERROR',
    };
  }
};

/**
 * Wrap a sidecar response into MCP tool result format.
 * Success → text content. Error → text content with isError flag.
 *
 * AGENTS.md security invariant #6: document/spreadsheet/slide content returned
 * by the add-in is authored inside Office files — attacker-influenced whenever
 * the file came from somewhere else. `sidecarRequest` stamps each add-in
 * payload with its source app; here every string in the payload (and any
 * add-in-relayed error message) is wrapped in the canonical
 * `<untrusted-content>` envelope before it reaches the model. Locally
 * generated errors (sidecar unreachable, etc.) carry no stamp and pass
 * through unwrapped.
 */
const UNTRUSTED_SOURCE = Symbol('officeUntrustedSource');

const untrustedSourceForApp = (app) => `microsoft-office-${app}`;

/**
 * Stamp a sidecar JSON payload with its source app. The stamp is a
 * non-enumerable Symbol-keyed property, so it never appears in
 * JSON.stringify output or in `wrapUntrustedJsonStrings`' object walk.
 */
const stampUntrustedSource = (payload, app) => {
  if (payload && typeof payload === 'object') {
    Object.defineProperty(payload, UNTRUSTED_SOURCE, {
      value: untrustedSourceForApp(app),
      enumerable: false,
      configurable: true,
    });
  }
  return payload;
};

const toMcpResult = (result) => {
  const source =
    result && typeof result === 'object' && typeof result[UNTRUSTED_SOURCE] === 'string'
      ? result[UNTRUSTED_SOURCE]
      : null;
  if (result.success === false) {
    const message = result.error || 'Unknown error';
    return {
      content: [{ type: 'text', text: source ? wrapUntrusted(message, source) : message }],
      isError: true,
    };
  }
  // Return the data payload as formatted JSON text
  const data = result.data !== undefined ? result.data : result;
  return {
    content: [{ type: 'text', text: JSON.stringify(source ? wrapUntrustedJsonStrings(data, source) : data, null, 2) }],
  };
};

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

const TOOL_NAMES = {
  // Setup & status
  setup: 'rebel_office_setup',
  status: 'rebel_office_status',

  readDocument: 'rebel_office_word_read_document',
  getDocumentStructure: 'rebel_office_word_get_document_structure',
  getSelection: 'rebel_office_word_get_selection',
  findText: 'rebel_office_word_find_text',
  insertText: 'rebel_office_word_insert_text',
  replaceText: 'rebel_office_word_replace_text',
  formatText: 'rebel_office_word_format_text',
  applyStyle: 'rebel_office_word_apply_style',
  insertTable: 'rebel_office_word_insert_table',
  readTable: 'rebel_office_word_read_table',
  updateTableCell: 'rebel_office_word_update_table_cell',
  insertImage: 'rebel_office_word_insert_image',
  insertBreak: 'rebel_office_word_insert_break',
  setHeaderFooter: 'rebel_office_word_set_header_footer',
  getProperties: 'rebel_office_word_get_properties',
  getComments: 'rebel_office_word_get_comments',
  addComment: 'rebel_office_word_add_comment',
  resolveComment: 'rebel_office_word_resolve_comment',
  getTrackedChanges: 'rebel_office_word_get_tracked_changes',
  acceptRejectChanges: 'rebel_office_word_accept_reject_changes',

  // Excel tools
  excelReadRange: 'rebel_office_excel_read_range',
  excelWriteRange: 'rebel_office_excel_write_range',
  excelGetWorksheets: 'rebel_office_excel_get_worksheets',
  excelAddWorksheet: 'rebel_office_excel_add_worksheet',
  excelDeleteWorksheet: 'rebel_office_excel_delete_worksheet',
  excelReadTable: 'rebel_office_excel_read_table',
  excelCreateTable: 'rebel_office_excel_create_table',
  excelSetFormula: 'rebel_office_excel_set_formula',
  excelGetFormulas: 'rebel_office_excel_get_formulas',
  excelCreateChart: 'rebel_office_excel_create_chart',
  excelFormatRange: 'rebel_office_excel_format_range',
  excelAddConditionalFormatting: 'rebel_office_excel_add_conditional_formatting',
  excelSortRange: 'rebel_office_excel_sort_range',
  excelFilterTable: 'rebel_office_excel_filter_table',
  excelGetNamedRanges: 'rebel_office_excel_get_named_ranges',
  excelInsertRowsColumns: 'rebel_office_excel_insert_rows_columns',
  excelDeleteRowsColumns: 'rebel_office_excel_delete_rows_columns',
  excelMergeCells: 'rebel_office_excel_merge_cells',
  excelAutoFit: 'rebel_office_excel_auto_fit',
  excelAddDataValidation: 'rebel_office_excel_add_data_validation',
  excelGetComments: 'rebel_office_excel_get_comments',
  excelAddComment: 'rebel_office_excel_add_comment',
  excelGetPivotTables: 'rebel_office_excel_get_pivot_tables',
  excelCreatePivotTable: 'rebel_office_excel_create_pivot_table',
  excelRefreshPivotTable: 'rebel_office_excel_refresh_pivot_table',

  // PowerPoint tools
  pptGetSlides: 'rebel_office_powerpoint_get_slides',
  pptGetSlideContent: 'rebel_office_powerpoint_get_slide_content',
  pptAddSlide: 'rebel_office_powerpoint_add_slide',
  pptApplyLayout: 'rebel_office_powerpoint_apply_layout',
  pptDeleteSlide: 'rebel_office_powerpoint_delete_slide',
  pptReorderSlides: 'rebel_office_powerpoint_reorder_slides',
  pptAddTextBox: 'rebel_office_powerpoint_add_text_box',
  pptAddImage: 'rebel_office_powerpoint_add_image',
  pptAddShape: 'rebel_office_powerpoint_add_shape',
  pptDeleteShape: 'rebel_office_powerpoint_delete_shape',
  pptFormatShape: 'rebel_office_powerpoint_format_shape',
  pptUpdateText: 'rebel_office_powerpoint_update_text',
  pptGetSpeakerNotes: 'rebel_office_powerpoint_get_speaker_notes',
  pptSetSpeakerNotes: 'rebel_office_powerpoint_set_speaker_notes',
  pptGetPresentationProperties: 'rebel_office_powerpoint_get_presentation_properties',
};

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'RebelOffice',
  version: PACKAGE_VERSION,
});

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
};

const jsonSchemaValidator = new AjvJsonSchemaValidator();
const registeredTools = new Map();

const createToolError = (errorMessage) => ({
  content: [
    {
      type: 'text',
      text: errorMessage,
    },
  ],
  isError: true,
});

/**
 * Register a tool into the local registry that backs the ListTools/CallTool
 * request handlers below. This is deliberately a plain function, not the SDK's
 * `McpServer#registerTool` — this server manages its own registry (see the
 * file header for why the SDK's Zod-based registration is not used here).
 */
const registerTool = (name, config, handler) => {
  if (registeredTools.has(name)) {
    throw new Error(`Tool ${name} is already registered`);
  }

  const tool = {
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema || EMPTY_OBJECT_SCHEMA,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    execution: { taskSupport: 'forbidden' },
    _meta: config._meta,
    handler,
    enabled: true,
    disable: () => {
      tool.enabled = false;
      return tool;
    },
    enable: () => {
      tool.enabled = true;
      return tool;
    },
    remove: () => {
      registeredTools.delete(name);
      return tool;
    },
  };

  registeredTools.set(name, tool);
  return tool;
};

server.server.registerCapabilities({
  tools: {
    listChanged: true,
  },
});

server.server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: Array.from(registeredTools.entries())
    .filter(([, tool]) => tool.enabled)
    .map(([name, tool]) => ({
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema || EMPTY_OBJECT_SCHEMA,
      annotations: tool.annotations,
      execution: tool.execution,
      _meta: tool._meta,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    })),
}));

server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const tool = registeredTools.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }
    if (!tool.enabled) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
    }

    const input = request.params.arguments ?? {};
    const validator = jsonSchemaValidator.getValidator(tool.inputSchema || EMPTY_OBJECT_SCHEMA);
    const validation = validator(input);
    if (!validation.valid) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Input validation error: Invalid arguments for tool ${request.params.name}: ${validation.errorMessage || 'Unknown validation error'}`
      );
    }

    return await Promise.resolve(tool.handler(validation.data, extra));
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired) {
      throw error;
    }
    return createToolError(error instanceof Error ? error.message : String(error));
  }
});

// ---------------------------------------------------------------------------
// Setup helpers — sideload manifest into Office wef folders
// ---------------------------------------------------------------------------

/**
 * macOS wef folder paths where Office looks for sideloaded add-in manifests.
 * Dropping a manifest.xml here makes the add-in appear automatically in the app.
 */
const MAC_WEF_PATHS = {
  word: path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef'),
  excel: path.join(os.homedir(), 'Library/Containers/com.microsoft.Excel/Data/Documents/wef'),
  powerpoint: path.join(os.homedir(), 'Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef'),
};

/**
 * Windows shared folder path for sideloaded manifests.
 * This is the per-user WEF folder (no admin needed).
 */
const WIN_WEF_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Office', '16.0', 'Wef')
  : null;

/**
 * Copy the manifest to all Office wef folders for the current platform.
 * Creates the wef directories if they don't exist.
 * Returns an array of {app, path, status} results.
 */
const installManifest = (manifestDir) => {
  const results = [];

  if (process.platform === 'darwin') {
    // Each Office app gets its own per-app manifest (single host per file)
    for (const [app, wefDir] of Object.entries(MAC_WEF_PATHS)) {
      const perAppManifest = path.join(manifestDir, `manifest.${app}.xml`);
      const fallbackManifest = path.join(manifestDir, 'manifest.xml');
      const source = fs.existsSync(perAppManifest) ? perAppManifest : fallbackManifest;

      try {
        fs.mkdirSync(wefDir, { recursive: true });
        fs.copyFileSync(source, path.join(wefDir, 'manifest.xml'));
        results.push({ app, path: wefDir, status: 'installed' });
      } catch (err) {
        results.push({ app, path: wefDir, status: 'failed', error: err.message });
      }
    }
  } else if (process.platform === 'win32' && WIN_WEF_PATH) {
    // Windows uses a single shared WEF folder — copy the default manifest
    const source = path.join(manifestDir, 'manifest.xml');
    try {
      fs.mkdirSync(WIN_WEF_PATH, { recursive: true });
      fs.copyFileSync(source, path.join(WIN_WEF_PATH, 'manifest.xml'));
      results.push({ app: 'all', path: WIN_WEF_PATH, status: 'installed' });
    } catch (err) {
      results.push({ app: 'all', path: WIN_WEF_PATH, status: 'failed', error: err.message });
    }
  } else {
    results.push({ app: 'all', path: 'unknown', status: 'skipped', error: `Unsupported platform: ${process.platform}` });
  }

  return results;
};

// No certificate trust needed — sidecar uses plain HTTP on localhost.

/**
 * Remove the manifest from all Office wef folders (uninstall).
 */
const uninstallManifest = () => {
  const results = [];
  const manifestName = 'manifest.xml';

  if (process.platform === 'darwin') {
    for (const [app, wefDir] of Object.entries(MAC_WEF_PATHS)) {
      const target = path.join(wefDir, manifestName);
      try {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
          results.push({ app, status: 'removed' });
        } else {
          results.push({ app, status: 'not_installed' });
        }
      } catch (err) {
        results.push({ app, status: 'failed', error: err.message });
      }
    }
  } else if (process.platform === 'win32' && WIN_WEF_PATH) {
    const target = path.join(WIN_WEF_PATH, manifestName);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        results.push({ app: 'all', status: 'removed' });
      } else {
        results.push({ app: 'all', status: 'not_installed' });
      }
    } catch (err) {
      results.push({ app: 'all', status: 'failed', error: err.message });
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// 0a. rebel_office_setup — (Re-)install or uninstall the Office add-in
registerTool(TOOL_NAMES.setup, {
  title: 'Install or repair Office add-in',
  description:
    'Re-installs or uninstalls the Rebel add-in in Microsoft Office (Word, Excel, PowerPoint).\n\n' +
    'You usually do NOT need to run this manually — the first Office tool call lazily starts ' +
    'the sidecar, which installs the add-in manifest automatically. Use this tool only to:\n' +
    '  • Force a re-install after deleting manifests manually\n' +
    '  • Uninstall the add-in (action="uninstall")\n\n' +
    'After install, open (or restart) Word, Excel, or PowerPoint. The Rebel button will appear ' +
    'in the Home ribbon, under the "Add ons" menu; click it to open the panel and see "Connected".',
  inputSchema: {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "install",
          "uninstall"
        ],
        "default": "install",
        "description": "Whether to install or uninstall the add-in."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (input) => {
  if (input.action === 'uninstall') {
    const results = uninstallManifest();
    const summary = results.map(r => `${r.app}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n');
    return {
      content: [{ type: 'text', text: `Add-in uninstalled:\n${summary}\n\nRestart any open Office apps to complete removal.` }],
    };
  }

  // Lazy-start the sidecar so we have a manifest + state file to work with
  try {
    await ensureSidecar();
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to start Office sidecar: ${err.message}` }],
      isError: true,
    };
  }

  const state = loadSidecarState();
  if (!state) {
    return {
      content: [{ type: 'text', text: "The Office sidecar started but state file not found. Try again." }],
      isError: true,
    };
  }

  // Install
  const steps = [];

  // Step 1: Install manifest to wef folders
  // manifestPath points to e.g. .../rebeloffice/manifest.xml — derive the directory
  const manifestDir = state.manifestPath ? path.dirname(state.manifestPath) : null;
  if (!manifestDir || !fs.existsSync(manifestDir)) {
    return {
      content: [{ type: 'text', text: 'Manifest directory not found. The sidecar may need to be restarted. Try disabling and re-enabling the Microsoft Office connector in Settings.' }],
      isError: true,
    };
  }

  const manifestResults = installManifest(manifestDir);
  const allInstalled = manifestResults.every(r => r.status === 'installed');
  steps.push({
    step: 'Install manifest',
    status: allInstalled ? 'done' : 'partial',
    details: manifestResults,
  });

  // Build summary
  const lines = ['Office add-in installation:'];
  for (const step of steps) {
    lines.push(`\n${step.step}: ${step.status}`);
    if (step.status === 'manual_needed' && step.details.manual) {
      lines.push(`  → ${step.details.manual}`);
    }
    if (Array.isArray(step.details)) {
      for (const d of step.details) {
        lines.push(`  ${d.app}: ${d.status}${d.error ? ` — ${d.error}` : ''}`);
      }
    }
  }

  lines.push('\nNext steps:');
  lines.push('1. Open (or restart) the Microsoft 365 desktop app for Word, Excel, or PowerPoint');
  lines.push('   (the web/browser versions of Office are not supported)');
  lines.push('2. Find the "Rebel" button in the Home ribbon, under the "Add ons" menu');
  lines.push('3. Click it to open the connection panel');
  lines.push('4. Once it shows "Connected", you\'re ready to go!');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
});

// 0b. rebel_office_status — Check connection status
registerTool(TOOL_NAMES.status, {
  title: 'Check Office connection status',
  description:
    'Check which Office applications are currently connected to Rebel. Returns connection ' +
    'status for Word, Excel, and PowerPoint, plus sidecar health information.\n\n' +
    'Use this to verify the connection before running other tools, or to diagnose ' +
    'issues when tools return "not connected" errors.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const state = loadSidecarState();
  if (!state) {
    return {
      content: [{ type: 'text', text: "The Office sidecar isn't running. Enable the Microsoft Office connector in Settings → Connectors, then run rebel_office_setup to install the add-in." }],
      isError: true,
    };
  }

  try {
    const url = `https://127.0.0.1:${state.port}/health`;
    // Loopback-scoped helper — see comment above `loopbackHttpsRequest`.
    const response = await loopbackHttpsRequest(url);
    const health = await response.json();

    const connected = health.connected || {};
    const apps = ['word', 'excel', 'powerpoint'];
    const lines = ['Office connection status:'];
    for (const app of apps) {
      const status = connected[app] ? 'Connected' : 'Not connected';
      lines.push(`  ${app.charAt(0).toUpperCase() + app.slice(1)}: ${status}`);
    }

    const anyConnected = apps.some(a => connected[a]);
    if (!anyConnected) {
      lines.push('\nNo Office apps are connected. Make sure you have:');
      lines.push('1. Run rebel_office_setup to install the add-in');
      lines.push('2. Opened Word, Excel, or PowerPoint');
      lines.push('3. Clicked the "Rebel" button in the Home ribbon (under the "Add ons" menu)');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Cannot reach Office sidecar: ${err.message}. Try restarting the connector in Settings.` }],
      isError: true,
    };
  }
});

// 1. rebel_office_word_read_document
registerTool(TOOL_NAMES.readDocument, {
  title: 'Read Word document',
  description:
    'Read the content of the currently open Word document. Returns the full text organized by ' +
    'paragraphs with heading levels, styles, and structure markers. Use this to understand ' +
    "what's in a document before making edits.\n\n" +
    'For very large documents, use the `maxParagraphs` parameter to limit output and ' +
    '`startParagraph` to paginate through content.\n\n' +
    'Common use cases: reviewing a draft, extracting key points, understanding document ' +
    'structure before making targeted edits.\n\n' +
    'Related tools: Use `rebel_office_word_get_document_structure` for a heading outline, ' +
    'or `rebel_office_word_find_text` to locate specific content.',
  inputSchema: {
    "type": "object",
    "properties": {
      "maxParagraphs": {
        "type": "integer",
        "minimum": 1,
        "maximum": 5000,
        "default": 500,
        "description": "Maximum paragraphs to return. Use for large documents."
      },
      "includeFormatting": {
        "type": "boolean",
        "default": false,
        "description": "Include font/style metadata per paragraph."
      },
      "startParagraph": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "Paragraph offset for pagination."
      }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'read_document', {
    maxParagraphs: input.maxParagraphs,
    includeFormatting: input.includeFormatting,
    startParagraph: input.startParagraph,
  });
  return toMcpResult(result);
});

// 2. rebel_office_word_get_document_structure
registerTool(TOOL_NAMES.getDocumentStructure, {
  title: 'Get document outline',
  description:
    'Get the outline structure of the currently open Word document — headings, sections, and ' +
    'page counts. Returns a hierarchical tree of headings with their levels and paragraph indices.\n\n' +
    'Useful for understanding document organization before making targeted edits, building a table ' +
    'of contents, or navigating to specific sections.\n\n' +
    'Related tools: Use `rebel_office_word_read_document` with `startParagraph` to read content ' +
    'at a specific heading location.',
  inputSchema: {
    "type": "object",
    "properties": {
      "includePageNumbers": {
        "type": "boolean",
        "default": true,
        "description": "Include approximate page numbers for each heading."
      }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'get_document_structure', {
    includePageNumbers: input.includePageNumbers,
  });
  return toMcpResult(result);
});

// 3. rebel_office_word_get_selection
registerTool(TOOL_NAMES.getSelection, {
  title: 'Get selected text',
  description:
    'Get the currently selected text in the Word document. Returns the text content and location ' +
    'of whatever the user has highlighted.\n\n' +
    'Useful for working with user-indicated content — "format this", "comment on this", ' +
    '"move this paragraph".\n\n' +
    'Related tools: After reading the selection, use `rebel_office_word_insert_text` with ' +
    'location "replaceSelection" to replace it, or `rebel_office_word_add_comment` with target ' +
    'type "selection" to comment on it.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  const result = await sidecarRequest('word', 'get_selection', {});
  return toMcpResult(result);
});

// 4. rebel_office_word_find_text
registerTool(TOOL_NAMES.findText, {
  title: 'Find text in document',
  description:
    'Search for text occurrences in the document. Returns matching locations with surrounding ' +
    'context. Supports case-sensitive and whole-word matching.\n\n' +
    'Use before `rebel_office_word_replace_text` to preview what will be changed, or to locate ' +
    'specific content for commenting or formatting.\n\n' +
    'Common use cases: finding all mentions of a term, locating a specific section, previewing ' +
    'search-and-replace matches before executing.',
  inputSchema: {
    "type": "object",
    "properties": {
      "searchText": {
        "type": "string",
        "minLength": 1,
        "description": "Text to search for."
      },
      "matchCase": {
        "type": "boolean",
        "default": false,
        "description": "Case-sensitive search."
      },
      "matchWholeWord": {
        "type": "boolean",
        "default": false,
        "description": "Match whole words only."
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500,
        "default": 50,
        "description": "Maximum results to return."
      }
    },
    "required": [
      "searchText"
    ]
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'find_text', {
    searchText: input.searchText,
    matchCase: input.matchCase,
    matchWholeWord: input.matchWholeWord,
    limit: input.limit,
  });
  return toMcpResult(result);
});

// 5. rebel_office_word_insert_text
registerTool(TOOL_NAMES.insertText, {
  title: 'Insert text',
  description:
    'Insert text into the document at a specified location. Can insert at the beginning, end, ' +
    'before/after a specific paragraph, or replace the current selection.\n\n' +
    'Text can include basic markdown-style formatting that gets converted to Word formatting. ' +
    'When track changes is enabled in the document, insertions appear as tracked additions.\n\n' +
    'Common use cases: adding new paragraphs, appending content, replacing selected text, ' +
    'inserting text at a specific location in the document.\n\n' +
    'Related tools: Use `rebel_office_word_read_document` to find the right paragraph index, ' +
    'or `rebel_office_word_get_selection` to check the current selection before replacing it.',
  inputSchema: {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "Text to insert. Supports basic markdown: **bold**, *italic*, # Heading 1, ## Heading 2, etc."
      },
      "location": {
        "type": "string",
        "enum": [
          "end",
          "start",
          "afterParagraph",
          "beforeParagraph",
          "replaceSelection"
        ],
        "default": "end",
        "description": "Where to insert the text."
      },
      "paragraphIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Target paragraph index (required for afterParagraph/beforeParagraph)."
      },
      "style": {
        "type": "string",
        "description": "Word style name to apply (e.g., \"Heading 1\", \"Normal\", \"Quote\")."
      }
    },
    "required": [
      "text"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'insert_text', {
    text: input.text,
    location: input.location,
    paragraphIndex: input.paragraphIndex,
    style: input.style,
  });
  return toMcpResult(result);
});

// 6. rebel_office_word_replace_text
registerTool(TOOL_NAMES.replaceText, {
  title: 'Find and replace text',
  description:
    'Find and replace text throughout the document. Supports case-sensitive and whole-word matching.\n\n' +
    'Use `rebel_office_word_find_text` first to preview matches before executing the replacement. ' +
    'When track changes is enabled, replacements appear as tracked changes (delete original + ' +
    'insert replacement). Returns the number of replacements made.\n\n' +
    'Common use cases: fixing typos throughout a document, updating terminology, standardizing ' +
    'formatting or naming conventions.',
  inputSchema: {
    "type": "object",
    "properties": {
      "searchText": {
        "type": "string",
        "minLength": 1,
        "description": "Text to find."
      },
      "replaceText": {
        "type": "string",
        "description": "Replacement text."
      },
      "matchCase": {
        "type": "boolean",
        "default": false,
        "description": "Case-sensitive matching."
      },
      "matchWholeWord": {
        "type": "boolean",
        "default": false,
        "description": "Whole word matching."
      },
      "replaceAll": {
        "type": "boolean",
        "default": true,
        "description": "Replace all occurrences or just the first."
      }
    },
    "required": [
      "searchText",
      "replaceText"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'replace_text', {
    searchText: input.searchText,
    replaceText: input.replaceText,
    matchCase: input.matchCase,
    matchWholeWord: input.matchWholeWord,
    replaceAll: input.replaceAll,
  });
  return toMcpResult(result);
});

// 7. rebel_office_word_format_text
registerTool(TOOL_NAMES.formatText, {
  title: 'Format text',
  description:
    'Apply formatting to text at a specified location — a paragraph range, the current selection, ' +
    'or text matching a search term. Supports font family, size, color, bold, italic, underline, ' +
    'highlight, and alignment.\n\n' +
    'For more complex formatting, use Word styles via `rebel_office_word_insert_text` with the ' +
    '`style` parameter.\n\n' +
    'Common use cases: making headings bold, changing font color for emphasis, highlighting ' +
    'key phrases, adjusting paragraph alignment.',
  inputSchema: {
    "type": "object",
    "properties": {
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "selection",
              "paragraphRange",
              "searchText"
            ],
            "description": "What to format: the current selection, a range of paragraphs, or text matching a search."
          },
          "startParagraph": {
            "type": "integer",
            "minimum": 0,
            "description": "Start paragraph index (for paragraphRange)."
          },
          "endParagraph": {
            "type": "integer",
            "minimum": 0,
            "description": "End paragraph index (for paragraphRange)."
          },
          "searchText": {
            "type": "string",
            "description": "Text to find and format (for searchText)."
          }
        },
        "required": [
          "type"
        ],
        "description": "What to format."
      },
      "formatting": {
        "type": "object",
        "properties": {
          "bold": {
            "type": "boolean",
            "description": "Apply bold."
          },
          "italic": {
            "type": "boolean",
            "description": "Apply italic."
          },
          "underline": {
            "type": "boolean",
            "description": "Apply underline."
          },
          "strikethrough": {
            "type": "boolean",
            "description": "Apply strikethrough."
          },
          "fontFamily": {
            "type": "string",
            "description": "Font family name (e.g., \"Calibri\", \"Arial\", \"Times New Roman\")."
          },
          "fontSize": {
            "type": "number",
            "minimum": 1,
            "maximum": 400,
            "description": "Font size in points."
          },
          "fontColor": {
            "type": "string",
            "description": "Font color as hex (e.g., \"#FF0000\")."
          },
          "highlightColor": {
            "type": "string",
            "enum": [
              "yellow",
              "green",
              "cyan",
              "magenta",
              "blue",
              "red",
              "darkBlue",
              "darkCyan",
              "darkGreen",
              "darkMagenta",
              "darkRed",
              "darkYellow",
              "gray25",
              "gray50",
              "black",
              "noHighlight"
            ],
            "description": "Highlight color name."
          },
          "alignment": {
            "type": "string",
            "enum": [
              "left",
              "center",
              "right",
              "justified"
            ],
            "description": "Paragraph alignment."
          }
        },
        "description": "Formatting options to apply."
      }
    },
    "required": [
      "target",
      "formatting"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'format_text', {
    target: input.target,
    formatting: input.formatting,
  });
  return toMcpResult(result);
});

// 8. rebel_office_word_insert_table
registerTool(TOOL_NAMES.insertTable, {
  title: 'Insert table',
  description:
    'Insert a table into the document. Provide headers and rows of data. The table is inserted ' +
    'at the end of the document or after a specific paragraph.\n\n' +
    'Tables are created with the default Word table style; specify a `style` for custom styling ' +
    '(e.g., "Grid Table 4 - Accent 1").\n\n' +
    'Common use cases: adding comparison tables, data summaries, structured lists, pricing tables.',
  inputSchema: {
    "type": "object",
    "properties": {
      "headers": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1,
        "description": "Column header names."
      },
      "rows": {
        "type": "array",
        "items": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "description": "Array of row arrays, each containing cell values."
      },
      "location": {
        "type": "string",
        "enum": [
          "end",
          "afterParagraph"
        ],
        "default": "end",
        "description": "Where to insert the table."
      },
      "paragraphIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Paragraph index for afterParagraph location."
      },
      "style": {
        "type": "string",
        "description": "Word table style name (e.g., \"Grid Table 4 - Accent 1\")."
      }
    },
    "required": [
      "headers",
      "rows"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'insert_table', {
    headers: input.headers,
    rows: input.rows,
    location: input.location,
    paragraphIndex: input.paragraphIndex,
    style: input.style,
  });
  return toMcpResult(result);
});

// 9. rebel_office_word_insert_image
registerTool(TOOL_NAMES.insertImage, {
  title: 'Insert image',
  description:
    'Insert an image into the document from a file path or base64 data. The image is inserted ' +
    'at the end or after a specific paragraph.\n\n' +
    'Supports width/height control — aspect ratio is maintained if only one dimension is specified.\n\n' +
    'Common use cases: adding screenshots, logos, charts generated externally, diagrams.',
  inputSchema: {
    "type": "object",
    "properties": {
      "source": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "filePath",
              "base64"
            ],
            "description": "Image source type."
          },
          "filePath": {
            "type": "string",
            "description": "Local file path to the image (for type \"filePath\")."
          },
          "base64": {
            "type": "string",
            "description": "Base64-encoded image data (for type \"base64\")."
          },
          "mimeType": {
            "type": "string",
            "description": "MIME type when using base64 (e.g., \"image/png\")."
          }
        },
        "required": [
          "type"
        ],
        "description": "Image source."
      },
      "location": {
        "type": "string",
        "enum": [
          "end",
          "afterParagraph",
          "replaceSelection"
        ],
        "default": "end",
        "description": "Where to insert the image."
      },
      "paragraphIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Paragraph index for afterParagraph location."
      },
      "width": {
        "type": "number",
        "minimum": 1,
        "description": "Width in points."
      },
      "height": {
        "type": "number",
        "minimum": 1,
        "description": "Height in points."
      }
    },
    "required": [
      "source"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'insert_image', {
    source: input.source,
    location: input.location,
    paragraphIndex: input.paragraphIndex,
    width: input.width,
    height: input.height,
  });
  return toMcpResult(result);
});

// 10. rebel_office_word_insert_break
registerTool(TOOL_NAMES.insertBreak, {
  title: 'Insert page/section break',
  description:
    'Insert a page break or section break into the document. Page breaks start a new page; ' +
    'section breaks start a new section (allowing different headers/footers/page layouts).\n\n' +
    'Common use cases: separating chapters, starting appendices on a new page, creating sections ' +
    'with different page orientations or margins.',
  inputSchema: {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "page",
          "sectionNextPage",
          "sectionContinuous"
        ],
        "description": "Break type: page break, section break (next page), or section break (continuous)."
      },
      "paragraphIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Insert after this paragraph. Defaults to end of document."
      }
    },
    "required": [
      "type"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'insert_break', {
    type: input.type,
    paragraphIndex: input.paragraphIndex,
  });
  return toMcpResult(result);
});

// 11. rebel_office_word_set_header_footer
registerTool(TOOL_NAMES.setHeaderFooter, {
  title: 'Set header or footer',
  description:
    'Set the header or footer text for the document. Can target the first page, odd pages, or ' +
    'even pages. Supports plain text and basic formatting.\n\n' +
    'Use special placeholders: `{PAGE}` for page number, `{NUMPAGES}` for total pages, ' +
    '`{DATE}` for current date.\n\n' +
    'Common use cases: adding page numbers, document titles, dates, or company branding to ' +
    'headers and footers.',
  inputSchema: {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "header",
          "footer"
        ],
        "description": "Header or footer."
      },
      "text": {
        "type": "string",
        "description": "Content text. Use {PAGE} for page number, {NUMPAGES} for total pages, {DATE} for current date."
      },
      "target": {
        "type": "string",
        "enum": [
          "default",
          "firstPage",
          "evenPages"
        ],
        "default": "default",
        "description": "Which pages to apply to."
      },
      "alignment": {
        "type": "string",
        "enum": [
          "left",
          "center",
          "right"
        ],
        "default": "center",
        "description": "Text alignment."
      }
    },
    "required": [
      "type",
      "text"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'set_header_footer', {
    type: input.type,
    text: input.text,
    target: input.target,
    alignment: input.alignment,
  });
  return toMcpResult(result);
});

// 12. rebel_office_word_get_properties
registerTool(TOOL_NAMES.getProperties, {
  title: 'Get document properties',
  description:
    "Get the document's metadata properties — title, author, creation date, last modified, " +
    'word count, page count, and custom properties.\n\n' +
    'Useful for understanding document context and provenance before making edits or when ' +
    'summarizing document metadata.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  const result = await sidecarRequest('word', 'get_properties', {});
  return toMcpResult(result);
});

// 13. rebel_office_word_get_comments
registerTool(TOOL_NAMES.getComments, {
  title: 'Read comments',
  description:
    'Read all comments in the document. Returns each comment with its author, date, associated ' +
    'text range, content, reply thread, and resolved status.\n\n' +
    'Use to review feedback, track discussion threads, or prepare a comment summary.\n\n' +
    'Related tools: Use `rebel_office_word_add_comment` to add new comments, ' +
    '`rebel_office_word_resolve_comment` to resolve or delete them.',
  inputSchema: {
    "type": "object",
    "properties": {
      "includeResolved": {
        "type": "boolean",
        "default": false,
        "description": "Include resolved comments in the results."
      }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'get_comments', {
    includeResolved: input.includeResolved,
  });
  return toMcpResult(result);
});

// 14. rebel_office_word_add_comment
registerTool(TOOL_NAMES.addComment, {
  title: 'Add comment',
  description:
    'Add a comment to the document at a specified location — the current selection, a paragraph, ' +
    'or text matching a search term. If replying to an existing comment, provide the parent ' +
    'comment ID to create a threaded reply.\n\n' +
    'Get comment IDs from `rebel_office_word_get_comments`.\n\n' +
    'Common use cases: providing feedback on specific paragraphs, noting issues, asking questions ' +
    'about document content.',
  inputSchema: {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "Comment text."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "selection",
              "paragraph",
              "searchText"
            ],
            "description": "Where to attach the comment."
          },
          "paragraphIndex": {
            "type": "integer",
            "minimum": 0,
            "description": "Paragraph index (for type \"paragraph\")."
          },
          "searchText": {
            "type": "string",
            "description": "Text to find and comment on — first occurrence (for type \"searchText\")."
          }
        },
        "required": [
          "type"
        ],
        "description": "Comment target location."
      },
      "replyToCommentId": {
        "type": "string",
        "description": "ID of parent comment to reply to (creates a threaded reply)."
      }
    },
    "required": [
      "text",
      "target"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'add_comment', {
    text: input.text,
    target: input.target,
    replyToCommentId: input.replyToCommentId,
  });
  return toMcpResult(result);
});

// 15. rebel_office_word_resolve_comment
registerTool(TOOL_NAMES.resolveComment, {
  title: 'Resolve or delete comment',
  description:
    'Resolve or delete a comment by its ID. Resolving marks a comment as addressed without ' +
    'removing it; deleting removes it entirely.\n\n' +
    'Get comment IDs from `rebel_office_word_get_comments`.\n\n' +
    'Common use cases: marking feedback as addressed, cleaning up resolved discussion threads.',
  inputSchema: {
    "type": "object",
    "properties": {
      "commentId": {
        "type": "string",
        "minLength": 1,
        "description": "Comment ID (from rebel_office_word_get_comments)."
      },
      "action": {
        "type": "string",
        "enum": [
          "resolve",
          "delete"
        ],
        "description": "Resolve (mark as addressed) or delete (remove entirely)."
      }
    },
    "required": [
      "commentId",
      "action"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'resolve_comment', {
    commentId: input.commentId,
    action: input.action,
  });
  return toMcpResult(result);
});

// 16. rebel_office_word_get_tracked_changes
registerTool(TOOL_NAMES.getTrackedChanges, {
  title: 'Read tracked changes',
  description:
    'Read tracked changes (revisions) in the document. Returns each change with its type ' +
    '(insertion, deletion, format change), author, date, and content.\n\n' +
    'Use to review edits before accepting or rejecting them.\n\n' +
    'Related tools: Use `rebel_office_word_accept_reject_changes` to accept or reject the changes.',
  inputSchema: {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000,
        "default": 100,
        "description": "Maximum changes to return."
      }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'get_tracked_changes', {
    limit: input.limit,
  });
  return toMcpResult(result);
});

// 17. rebel_office_word_accept_reject_changes
registerTool(TOOL_NAMES.acceptRejectChanges, {
  title: 'Accept or reject tracked changes',
  description:
    'Accept or reject tracked changes in the document. Can target specific changes by ID, all ' +
    'changes, or all changes from a specific author.\n\n' +
    'Get change IDs from `rebel_office_word_get_tracked_changes`.\n\n' +
    'Common use cases: bulk-accepting all tracked changes after review, rejecting changes from ' +
    'a specific reviewer, selectively accepting individual edits.',
  inputSchema: {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "accept",
          "reject"
        ],
        "description": "Accept or reject the changes."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "specific",
              "all",
              "byAuthor"
            ],
            "description": "Which changes to target."
          },
          "changeIds": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Specific change IDs (for type \"specific\")."
          },
          "author": {
            "type": "string",
            "description": "Author name (for type \"byAuthor\")."
          }
        },
        "required": [
          "type"
        ],
        "description": "Which tracked changes to act on."
      }
    },
    "required": [
      "action",
      "target"
    ]
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (input) => {
  const result = await sidecarRequest('word', 'accept_reject_changes', {
    action: input.action,
    target: input.target,
  });
  return toMcpResult(result);
});

// 18. rebel_office_word_read_table
registerTool(TOOL_NAMES.readTable, {
  title: 'Read Word table',
  description:
    'Read a table in the document as a 2D array of cell text. Tables are indexed 0-based in ' +
    'document order; omit `tableIndex` to read the first table.\n\n' +
    'Use this to see what a table contains before editing it with ' +
    '`rebel_office_word_update_table_cell`. Create new tables with `rebel_office_word_insert_table`.',
  inputSchema: {
    "type": "object",
    "properties": {
      "tableIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Which table to read (0-based — the first table in the document is 0). Defaults to 0."
      }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('word', 'read_table', {
    tableIndex: input.tableIndex,
  });
  return toMcpResult(result);
});

// 19. rebel_office_word_update_table_cell
registerTool(TOOL_NAMES.updateTableCell, {
  title: 'Update Word table cell',
  description:
    'Replace the text of a single cell in an existing table. Row and column indexes are 0-based ' +
    '(the top-left cell is row 0, column 0). Pass an empty `text` to clear a cell.\n\n' +
    'Use `rebel_office_word_read_table` first to see the current contents and dimensions.',
  inputSchema: {
    "type": "object",
    "properties": {
      "tableIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Which table to edit (0-based). Defaults to 0."
      },
      "rowIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Row of the cell (0-based)."
      },
      "columnIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "Column of the cell (0-based)."
      },
      "text": {
        "type": "string",
        "description": "New cell text. May be empty to clear the cell."
      }
    },
    "required": [
      "rowIndex",
      "columnIndex",
      "text"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('word', 'update_table_cell', {
    tableIndex: input.tableIndex,
    rowIndex: input.rowIndex,
    columnIndex: input.columnIndex,
    text: input.text,
  });
  return toMcpResult(result);
});

// 20. rebel_office_word_apply_style
registerTool(TOOL_NAMES.applyStyle, {
  title: 'Apply Word style to paragraphs',
  description:
    'Apply a named paragraph style to existing paragraphs — built-in styles like "Heading 1", ' +
    '"Title", or "Quote", or any custom style defined in the document. Target the current ' +
    'selection, a range of paragraphs, or every paragraph containing a search text.\n\n' +
    'Styles are how Word documents stay consistent — prefer this over manual font formatting ' +
    '(`rebel_office_word_format_text`) when making headings, quotes, or other structural text ' +
    'look intentional. To style new text at insertion time, use `rebel_office_word_insert_text` ' +
    'with its `style` parameter.',
  inputSchema: {
    "type": "object",
    "properties": {
      "style": {
        "type": "string",
        "minLength": 1,
        "description": "Style name, e.g. \"Heading 1\", \"Title\", \"Subtitle\", \"Quote\", \"Intense Quote\", \"No Spacing\", or a custom style defined in the document."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "selection",
              "paragraphRange",
              "searchText"
            ],
            "description": "Which paragraphs to style: the current selection, a range of paragraphs, or paragraphs containing a search text."
          },
          "startParagraph": {
            "type": "integer",
            "minimum": 0,
            "description": "Start paragraph index, 0-based (for paragraphRange)."
          },
          "endParagraph": {
            "type": "integer",
            "minimum": 0,
            "description": "End paragraph index, 0-based, inclusive (for paragraphRange; defaults to startParagraph)."
          },
          "searchText": {
            "type": "string",
            "description": "Style every paragraph containing this text (for searchText)."
          }
        },
        "required": [
          "type"
        ],
        "description": "Which paragraphs to style."
      }
    },
    "required": [
      "style",
      "target"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('word', 'apply_style', {
    style: input.style,
    target: input.target,
  });
  return toMcpResult(result);
});

// ---------------------------------------------------------------------------
// Excel tool definitions (22 tools)
// ---------------------------------------------------------------------------

// 21. rebel_office_excel_read_range
registerTool(TOOL_NAMES.excelReadRange, {
  title: 'Read Excel range',
  description:
    'Read cell values from a range in the active workbook. Returns data as a 2D array with ' +
    'column headers from the first row (if `hasHeaders` is true) or as raw arrays.\n\n' +
    'For named ranges, provide the range name directly. For tables, prefer `rebel_office_excel_read_table`.\n\n' +
    'Common use cases: reading data for analysis, extracting specific cells, getting a table snapshot.\n\n' +
    'Related tools: Use `rebel_office_excel_get_worksheets` to discover available sheets, ' +
    'or `rebel_office_excel_get_named_ranges` to find named ranges.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation (e.g., \"A1:D10\", \"Sheet2!B3:F20\") or a named range."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to the active sheet. Overrides any sheet prefix in range."
      },
      "hasHeaders": {
        "type": "boolean",
        "default": true,
        "description": "Treat the first row as column headers."
      },
      "return_json": {
        "type": "boolean",
        "default": false,
        "description": "Return as array of objects (keyed by headers) instead of 2D array."
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000,
        "default": 1000,
        "description": "Maximum rows to return."
      }
    },
    "required": [
      "range"
    ]
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'read_range', {
    range: input.range, worksheet: input.worksheet, hasHeaders: input.hasHeaders,
    return_json: input.return_json, limit: input.limit,
  });
  return toMcpResult(result);
});

// 22. rebel_office_excel_write_range
registerTool(TOOL_NAMES.excelWriteRange, {
  title: 'Write Excel range',
  description:
    'Write values to cells in the active workbook. Provide data as a 2D array of values. ' +
    'Supports numbers, strings, booleans, and null (for empty cells). Auto-expands the target ' +
    'range to fit the data dimensions.\n\n' +
    'Use `rebel_office_excel_set_formula` for formula cells.\n\n' +
    'Common use cases: populating a spreadsheet, updating existing data, bulk data entry.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Starting cell in A1 notation (e.g., \"A1\", \"Sheet2!C5\"). Data fills rightward and downward."
      },
      "values": {
        "type": "array",
        "items": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "minItems": 1,
        "description": "2D array of values. Each inner array is a row."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to active sheet."
      }
    },
    "required": [
      "range",
      "values"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'write_range', {
    range: input.range, values: input.values, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 23. rebel_office_excel_get_worksheets
registerTool(TOOL_NAMES.excelGetWorksheets, {
  title: 'List worksheets',
  description:
    'List all worksheets in the active workbook with their names, positions, visibility, and ' +
    'basic info (used range, row/column counts).\n\n' +
    'Use this to discover available sheets before reading or writing data.\n\n' +
    'Related tools: Use `rebel_office_excel_add_worksheet` to create new sheets.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const result = await sidecarRequest('excel', 'get_worksheets', {});
  return toMcpResult(result);
});

// 24. rebel_office_excel_add_worksheet
registerTool(TOOL_NAMES.excelAddWorksheet, {
  title: 'Add worksheet',
  description:
    'Add a new worksheet to the workbook. Optionally specify a name and position. Returns the ' +
    "new sheet's name and index.\n\n" +
    'Related tools: Use `rebel_office_excel_delete_worksheet` to remove sheets.',
  inputSchema: {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Sheet name. Auto-generated if omitted (e.g., \"Sheet4\")."
      },
      "position": {
        "type": "string",
        "enum": [
          "end",
          "start",
          "afterSheet"
        ],
        "default": "end",
        "description": "Where to insert."
      },
      "afterSheet": {
        "type": "string",
        "description": "Sheet name to insert after (for position: \"afterSheet\")."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'add_worksheet', {
    name: input.name, position: input.position, afterSheet: input.afterSheet,
  });
  return toMcpResult(result);
});

// 25. rebel_office_excel_delete_worksheet
registerTool(TOOL_NAMES.excelDeleteWorksheet, {
  title: 'Delete worksheet',
  description:
    'Delete a worksheet from the workbook. **This permanently removes the sheet and all its ' +
    'data — cannot be undone.** Returns confirmation of deletion.',
  inputSchema: {
    "type": "object",
    "properties": {
      "worksheet": {
        "type": "string",
        "minLength": 1,
        "description": "Name of the worksheet to delete."
      }
    },
    "required": [
      "worksheet"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'delete_worksheet', { worksheet: input.worksheet });
  return toMcpResult(result);
});

// 26. rebel_office_excel_read_table
registerTool(TOOL_NAMES.excelReadTable, {
  title: 'Read Excel table',
  description:
    'Read data from a named Excel table (ListObject). Returns headers and rows with type ' +
    'information. Tables are structured ranges with automatic filtering and sorting capabilities.\n\n' +
    'Preferred over `rebel_office_excel_read_range` for structured data.\n\n' +
    'Related tools: Use `rebel_office_excel_get_named_ranges` to discover available tables.',
  inputSchema: {
    "type": "object",
    "properties": {
      "tableName": {
        "type": "string",
        "minLength": 1,
        "description": "Name of the Excel table."
      },
      "return_json": {
        "type": "boolean",
        "default": true,
        "description": "Return as array of objects (keyed by headers)."
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000,
        "default": 1000,
        "description": "Maximum rows to return."
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "Row offset for pagination."
      }
    },
    "required": [
      "tableName"
    ]
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'read_table', {
    tableName: input.tableName, return_json: input.return_json, limit: input.limit, offset: input.offset,
  });
  return toMcpResult(result);
});

// 27. rebel_office_excel_create_table
registerTool(TOOL_NAMES.excelCreateTable, {
  title: 'Create Excel table',
  description:
    'Convert a cell range into a named Excel table with headers. Tables enable structured ' +
    'references, automatic filtering, and formatted data management. The first row of the ' +
    'range becomes the header row.\n\n' +
    'Related tools: Use `rebel_office_excel_read_table` to read from tables.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation (must include the header row)."
      },
      "name": {
        "type": "string",
        "description": "Table name. Auto-generated if omitted."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to active sheet."
      },
      "style": {
        "type": "string",
        "description": "Table style (e.g., \"TableStyleMedium2\", \"TableStyleLight1\")."
      }
    },
    "required": [
      "range"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'create_table', {
    range: input.range, name: input.name, worksheet: input.worksheet, style: input.style,
  });
  return toMcpResult(result);
});

// 28. rebel_office_excel_set_formula
registerTool(TOOL_NAMES.excelSetFormula, {
  title: 'Set formula',
  description:
    'Set a formula in one or more cells. Supports standard Excel formulas (SUM, VLOOKUP, IF, etc.), ' +
    'array formulas, and dynamic array formulas. The formula is entered exactly as provided — ' +
    'include the leading `=`.\n\n' +
    'For bulk formulas applied to a column, use the `fillDown` option.\n\n' +
    'Common use cases: adding calculated columns, creating summary formulas, building dashboards.',
  inputSchema: {
    "type": "object",
    "properties": {
      "cell": {
        "type": "string",
        "minLength": 1,
        "description": "Cell in A1 notation (e.g., \"E2\")."
      },
      "formula": {
        "type": "string",
        "minLength": 1,
        "description": "Formula string including the = sign (e.g., \"=SUM(A1:A10)\")."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to active sheet."
      },
      "fillDown": {
        "type": "integer",
        "minimum": 1,
        "description": "Number of rows to fill down with the formula."
      }
    },
    "required": [
      "cell",
      "formula"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'set_formula', {
    cell: input.cell, formula: input.formula, worksheet: input.worksheet, fillDown: input.fillDown,
  });
  return toMcpResult(result);
});

// 29. rebel_office_excel_get_formulas
registerTool(TOOL_NAMES.excelGetFormulas, {
  title: 'Read formulas',
  description:
    'Read the formulas (not computed values) from a range of cells. Returns the formula strings ' +
    'for each cell. Cells without formulas return their literal values.\n\n' +
    'Useful for understanding calculation logic, auditing spreadsheets, or debugging formula errors.\n\n' +
    'Related tools: Use `rebel_office_excel_read_range` to get computed values instead.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to active sheet."
      }
    },
    "required": [
      "range"
    ]
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'get_formulas', {
    range: input.range, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 30. rebel_office_excel_create_chart
registerTool(TOOL_NAMES.excelCreateChart, {
  title: 'Create chart',
  description:
    'Create a chart from data in the workbook. Supports bar, column, line, pie, area, scatter, ' +
    'doughnut, and radar chart types. The chart is embedded in the specified worksheet.\n\n' +
    'Provide a data range including headers for automatic series detection.\n\n' +
    'Common use cases: visualizing trends, creating dashboards, presenting data summaries.',
  inputSchema: {
    "type": "object",
    "properties": {
      "dataRange": {
        "type": "string",
        "minLength": 1,
        "description": "Data range in A1 notation including headers (e.g., \"A1:C12\")."
      },
      "chartType": {
        "type": "string",
        "enum": [
          "bar",
          "column",
          "line",
          "pie",
          "area",
          "scatter",
          "doughnut",
          "radar"
        ],
        "description": "Chart type."
      },
      "title": {
        "type": "string",
        "description": "Chart title."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet to place the chart on. Defaults to the data's sheet."
      },
      "position": {
        "type": "object",
        "properties": {
          "left": {
            "type": "number",
            "description": "Left position in points."
          },
          "top": {
            "type": "number",
            "description": "Top position in points."
          },
          "width": {
            "type": "number",
            "description": "Width in points."
          },
          "height": {
            "type": "number",
            "description": "Height in points."
          }
        },
        "required": [
          "left",
          "top",
          "width",
          "height"
        ],
        "description": "Chart position and size in points."
      },
      "seriesOrientation": {
        "type": "string",
        "enum": [
          "columns",
          "rows"
        ],
        "default": "columns",
        "description": "Whether data series are in columns or rows."
      }
    },
    "required": [
      "dataRange",
      "chartType"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'create_chart', {
    dataRange: input.dataRange, chartType: input.chartType, title: input.title,
    worksheet: input.worksheet, position: input.position, seriesOrientation: input.seriesOrientation,
  });
  return toMcpResult(result);
});

// 31. rebel_office_excel_format_range
registerTool(TOOL_NAMES.excelFormatRange, {
  title: 'Format Excel range',
  description:
    'Apply formatting to a cell range — font, colors, borders, number format, alignment, and fill.\n\n' +
    'Common use cases: highlighting important cells, formatting currency/percentages, adding borders ' +
    'to tables, color-coding categories.\n\n' +
    'Related tools: Use `rebel_office_excel_add_conditional_formatting` for rule-based formatting.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name. Defaults to active sheet."
      },
      "formatting": {
        "type": "object",
        "properties": {
          "bold": {
            "type": "boolean",
            "description": "Apply bold."
          },
          "italic": {
            "type": "boolean",
            "description": "Apply italic."
          },
          "underline": {
            "type": "boolean",
            "description": "Apply underline."
          },
          "fontFamily": {
            "type": "string",
            "description": "Font family (e.g., \"Calibri\")."
          },
          "fontSize": {
            "type": "number",
            "minimum": 1,
            "maximum": 400,
            "description": "Font size in points."
          },
          "fontColor": {
            "type": "string",
            "description": "Font hex color (e.g., \"#FF0000\")."
          },
          "fillColor": {
            "type": "string",
            "description": "Background fill hex color."
          },
          "numberFormat": {
            "type": "string",
            "description": "Excel number format code (e.g., \"#,##0.00\", \"0%\", \"yyyy-mm-dd\", \"$#,##0\")."
          },
          "horizontalAlignment": {
            "type": "string",
            "enum": [
              "left",
              "center",
              "right",
              "fill"
            ],
            "description": "Horizontal alignment."
          },
          "verticalAlignment": {
            "type": "string",
            "enum": [
              "top",
              "center",
              "bottom"
            ],
            "description": "Vertical alignment."
          },
          "wrapText": {
            "type": "boolean",
            "description": "Wrap text in cells."
          },
          "borders": {
            "type": "object",
            "properties": {
              "style": {
                "type": "string",
                "enum": [
                  "thin",
                  "medium",
                  "thick",
                  "dashed",
                  "dotted"
                ],
                "description": "Border style."
              },
              "color": {
                "type": "string",
                "description": "Border hex color."
              },
              "edges": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Which edges: \"top\", \"bottom\", \"left\", \"right\", \"insideHorizontal\", \"insideVertical\". Default: all."
              }
            },
            "description": "Border settings."
          }
        },
        "description": "Formatting options to apply."
      }
    },
    "required": [
      "range",
      "formatting"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'format_range', {
    range: input.range, worksheet: input.worksheet, formatting: input.formatting,
  });
  return toMcpResult(result);
});

// 32. rebel_office_excel_add_conditional_formatting
registerTool(TOOL_NAMES.excelAddConditionalFormatting, {
  title: 'Add conditional formatting',
  description:
    'Add conditional formatting rules to a range. Supports color scales, data bars, icon sets, ' +
    'and cell-value-based rules.\n\n' +
    'Common use cases: heat maps for data, traffic-light indicators, highlighting cells ' +
    'above/below thresholds.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      },
      "rule": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "cellValue",
              "colorScale",
              "dataBar",
              "iconSet",
              "topBottom"
            ],
            "description": "Rule type."
          },
          "operator": {
            "type": "string",
            "enum": [
              "greaterThan",
              "lessThan",
              "between",
              "equalTo",
              "notEqualTo",
              "greaterThanOrEqual",
              "lessThanOrEqual"
            ],
            "description": "Comparison operator (for cellValue type)."
          },
          "values": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "number"
                }
              ]
            },
            "description": "Threshold values."
          },
          "format": {
            "type": "object",
            "additionalProperties": {},
            "description": "Format to apply when condition is met."
          },
          "colorScale": {
            "type": "object",
            "properties": {
              "minimum": {
                "type": "object",
                "properties": {
                  "color": {
                    "type": "string"
                  }
                },
                "required": [
                  "color"
                ]
              },
              "midpoint": {
                "type": "object",
                "properties": {
                  "color": {
                    "type": "string"
                  }
                },
                "required": [
                  "color"
                ]
              },
              "maximum": {
                "type": "object",
                "properties": {
                  "color": {
                    "type": "string"
                  }
                },
                "required": [
                  "color"
                ]
              }
            },
            "required": [
              "minimum",
              "maximum"
            ],
            "description": "Color scale configuration."
          }
        },
        "required": [
          "type"
        ],
        "description": "Conditional formatting rule."
      }
    },
    "required": [
      "range",
      "rule"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'add_conditional_formatting', {
    range: input.range, worksheet: input.worksheet, rule: input.rule,
  });
  return toMcpResult(result);
});

// 33. rebel_office_excel_sort_range
registerTool(TOOL_NAMES.excelSortRange, {
  title: 'Sort range or table',
  description:
    'Sort a range or table by one or more columns. Supports ascending/descending order and ' +
    'multi-level sorting. When sorting a table, use column names; when sorting a range, use ' +
    'column letters or indices.\n\n' +
    'Related tools: Use `rebel_office_excel_filter_table` to filter without reordering data.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "description": "Cell range in A1 notation. Either range or tableName is required."
      },
      "tableName": {
        "type": "string",
        "description": "Name of an Excel table to sort."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      },
      "sortFields": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "column": {
              "type": "string",
              "description": "Column letter (e.g., \"B\") or header name for tables."
            },
            "ascending": {
              "type": "boolean",
              "default": true,
              "description": "Sort direction."
            }
          },
          "required": [
            "column"
          ]
        },
        "minItems": 1,
        "description": "Sort criteria (applied in order)."
      }
    },
    "required": [
      "sortFields"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'sort_range', {
    range: input.range, tableName: input.tableName, worksheet: input.worksheet, sortFields: input.sortFields,
  });
  return toMcpResult(result);
});

// 34. rebel_office_excel_filter_table
registerTool(TOOL_NAMES.excelFilterTable, {
  title: 'Filter table',
  description:
    'Apply or clear auto-filter on an Excel table or range. Filter by specific values, ' +
    'conditions, or clear all filters. Use to focus on relevant data subsets without removing rows.\n\n' +
    'Related tools: Use `rebel_office_excel_sort_range` to reorder data.',
  inputSchema: {
    "type": "object",
    "properties": {
      "tableName": {
        "type": "string",
        "description": "Table name. Either tableName or range is required."
      },
      "range": {
        "type": "string",
        "description": "Cell range with headers."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      },
      "filters": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "column": {
              "type": "string",
              "description": "Column header name or letter."
            },
            "criteria": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "values",
                    "condition"
                  ],
                  "description": "Filter type."
                },
                "values": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "For values type: exact values to show."
                },
                "operator": {
                  "type": "string",
                  "description": "For condition type: \"greaterThan\", \"lessThan\", \"equals\", etc."
                },
                "value": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    }
                  ],
                  "description": "For condition type: threshold value."
                }
              },
              "required": [
                "type"
              ],
              "description": "Filter criteria."
            }
          },
          "required": [
            "column",
            "criteria"
          ]
        },
        "description": "Filter criteria. Omit to clear all filters."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'filter_table', {
    tableName: input.tableName, range: input.range, worksheet: input.worksheet, filters: input.filters,
  });
  return toMcpResult(result);
});

// 35. rebel_office_excel_get_named_ranges
registerTool(TOOL_NAMES.excelGetNamedRanges, {
  title: 'List named ranges and tables',
  description:
    'List all named ranges and tables in the workbook. Returns name, scope (workbook or worksheet), ' +
    'reference, and type (named range or table).\n\n' +
    'Useful for discovering available data structures before reading.\n\n' +
    'Related tools: Use `rebel_office_excel_read_table` for table data, ' +
    '`rebel_office_excel_read_range` for named ranges.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const result = await sidecarRequest('excel', 'get_named_ranges', {});
  return toMcpResult(result);
});

// 36. rebel_office_excel_insert_rows_columns
registerTool(TOOL_NAMES.excelInsertRowsColumns, {
  title: 'Insert rows or columns',
  description:
    'Insert new rows or columns into a worksheet. Existing data shifts to accommodate the insertion.\n\n' +
    'Use for adding space for new data, inserting summary rows, or expanding tables.',
  inputSchema: {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "rows",
          "columns"
        ],
        "description": "What to insert."
      },
      "position": {
        "type": "string",
        "minLength": 1,
        "description": "Row number (e.g., \"5\") or column letter (e.g., \"C\") to insert before."
      },
      "count": {
        "type": "integer",
        "minimum": 1,
        "default": 1,
        "description": "Number of rows/columns to insert."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      }
    },
    "required": [
      "type",
      "position"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'insert_rows_columns', {
    type: input.type, position: input.position, count: input.count, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 37. rebel_office_excel_delete_rows_columns
registerTool(TOOL_NAMES.excelDeleteRowsColumns, {
  title: 'Delete rows or columns',
  description:
    'Delete rows or columns from a worksheet. **This permanently removes the data in those ' +
    'rows/columns — cannot be undone.** Remaining data shifts to fill the gap.',
  inputSchema: {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "rows",
          "columns"
        ],
        "description": "What to delete."
      },
      "start": {
        "type": "string",
        "minLength": 1,
        "description": "Starting row number or column letter."
      },
      "count": {
        "type": "integer",
        "minimum": 1,
        "default": 1,
        "description": "Number of rows/columns to delete."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      }
    },
    "required": [
      "type",
      "start"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'delete_rows_columns', {
    type: input.type, start: input.start, count: input.count, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 38. rebel_office_excel_merge_cells
registerTool(TOOL_NAMES.excelMergeCells, {
  title: 'Merge or unmerge cells',
  description:
    'Merge or unmerge cells in a range. Merged cells combine into a single cell displaying the ' +
    'upper-left value. Use for headers spanning multiple columns or creating visual groupings.\n\n' +
    '**Warning: merging discards values from all cells except the upper-left.**',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range to merge/unmerge."
      },
      "action": {
        "type": "string",
        "enum": [
          "merge",
          "unmerge"
        ],
        "description": "Merge or unmerge."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      }
    },
    "required": [
      "range",
      "action"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'merge_cells', {
    range: input.range, action: input.action, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 39. rebel_office_excel_auto_fit
registerTool(TOOL_NAMES.excelAutoFit, {
  title: 'Auto-fit columns or rows',
  description:
    'Auto-fit column widths or row heights to fit content. Makes data readable without manual ' +
    'column resizing. Apply to specific columns/rows or the entire used range.',
  inputSchema: {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "enum": [
          "columns",
          "rows",
          "both"
        ],
        "default": "columns",
        "description": "What to auto-fit."
      },
      "range": {
        "type": "string",
        "description": "Range to auto-fit. Defaults to the entire used range."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'auto_fit', {
    target: input.target, range: input.range, worksheet: input.worksheet,
  });
  return toMcpResult(result);
});

// 40. rebel_office_excel_add_data_validation
registerTool(TOOL_NAMES.excelAddDataValidation, {
  title: 'Add data validation',
  description:
    'Add data validation rules to a cell range. Restricts what values can be entered — dropdown ' +
    'lists, number ranges, date ranges, text length limits, or custom formulas.\n\n' +
    'Common use cases: dropdown menus for status columns, ensuring numeric fields only accept ' +
    'numbers, date range constraints.',
  inputSchema: {
    "type": "object",
    "properties": {
      "range": {
        "type": "string",
        "minLength": 1,
        "description": "Cell range in A1 notation."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      },
      "rule": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "list",
              "wholeNumber",
              "decimal",
              "date",
              "textLength",
              "custom"
            ],
            "description": "Validation type."
          },
          "values": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "For list type: allowed values (creates a dropdown)."
          },
          "operator": {
            "type": "string",
            "enum": [
              "between",
              "greaterThan",
              "lessThan",
              "equalTo",
              "notBetween"
            ],
            "description": "For numeric/date/text types."
          },
          "minimum": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              }
            ],
            "description": "Min value."
          },
          "maximum": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              }
            ],
            "description": "Max value."
          },
          "formula": {
            "type": "string",
            "description": "For custom type: formula that returns TRUE/FALSE."
          }
        },
        "required": [
          "type"
        ],
        "description": "Validation rule."
      },
      "showErrorAlert": {
        "type": "boolean",
        "default": true,
        "description": "Show error when invalid data is entered."
      },
      "errorMessage": {
        "type": "string",
        "description": "Custom error message."
      }
    },
    "required": [
      "range",
      "rule"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'add_data_validation', {
    range: input.range, worksheet: input.worksheet, rule: input.rule,
    showErrorAlert: input.showErrorAlert, errorMessage: input.errorMessage,
  });
  return toMcpResult(result);
});

// 41. rebel_office_excel_get_comments
registerTool(TOOL_NAMES.excelGetComments, {
  title: 'Read Excel comments',
  description:
    'Read all comments in the workbook or a specific worksheet. Returns each comment with its ' +
    'cell location, author, text, reply thread, and resolved status.\n\n' +
    'Excel supports threaded comments — replies are nested under the parent.\n\n' +
    'Related tools: Use `rebel_office_excel_add_comment` to add new comments.',
  inputSchema: {
    "type": "object",
    "properties": {
      "worksheet": {
        "type": "string",
        "description": "Limit to a specific worksheet. Defaults to all sheets."
      },
      "includeResolved": {
        "type": "boolean",
        "default": false,
        "description": "Include resolved comments."
      }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'get_comments', {
    worksheet: input.worksheet, includeResolved: input.includeResolved,
  });
  return toMcpResult(result);
});

// 42. rebel_office_excel_add_comment
registerTool(TOOL_NAMES.excelAddComment, {
  title: 'Add Excel comment',
  description:
    'Add a comment to a specific cell. Comments appear as threaded discussions anchored to cells. ' +
    'Provide a cell reference and comment text. To reply to an existing comment thread, provide ' +
    'the parent comment ID.\n\n' +
    'Related tools: Use `rebel_office_excel_get_comments` to read existing comments.',
  inputSchema: {
    "type": "object",
    "properties": {
      "cell": {
        "type": "string",
        "minLength": 1,
        "description": "Cell reference in A1 notation (e.g., \"B5\")."
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "Comment text."
      },
      "worksheet": {
        "type": "string",
        "description": "Worksheet name."
      },
      "replyToCommentId": {
        "type": "string",
        "description": "Parent comment ID for threaded replies."
      }
    },
    "required": [
      "cell",
      "text"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'add_comment', {
    cell: input.cell, text: input.text, worksheet: input.worksheet, replyToCommentId: input.replyToCommentId,
  });
  return toMcpResult(result);
});

// 43. rebel_office_excel_get_pivot_tables
registerTool(TOOL_NAMES.excelGetPivotTables, {
  title: 'List pivot tables',
  description:
    'List every pivot table in the workbook with its name and the worksheet it lives on.\n\n' +
    'Use this to discover existing pivot tables before refreshing them with ' +
    '`rebel_office_excel_refresh_pivot_table`.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const result = await sidecarRequest('excel', 'get_pivot_tables', {});
  return toMcpResult(result);
});

// 44. rebel_office_excel_create_pivot_table
registerTool(TOOL_NAMES.excelCreatePivotTable, {
  title: 'Create pivot table',
  description:
    'Create a pivot table from a source data range. By default the pivot table is placed on a ' +
    'new worksheet named after it; pass `destinationWorksheet` to place it on an existing sheet.\n\n' +
    'The pivot table is created without arranged fields — row, column, and value fields are ' +
    'arranged in Excel afterwards (the pivot table API cannot arrange fields).\n\n' +
    'Requires an Excel version supporting the pivot table API (ExcelApi 1.8+).',
  inputSchema: {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "description": "Name for the new pivot table."
      },
      "sourceRange": {
        "type": "string",
        "minLength": 1,
        "description": "A1-style range of the source data, e.g. \"A1:D100\". The first row should be headers."
      },
      "sourceWorksheet": {
        "type": "string",
        "description": "Worksheet holding the source range. Defaults to the active worksheet."
      },
      "destinationWorksheet": {
        "type": "string",
        "description": "Existing worksheet to place the pivot table on. When omitted, a new worksheet named after the pivot table is created (it must not already exist)."
      },
      "destinationCell": {
        "type": "string",
        "description": "Top-left cell of the pivot table on the destination worksheet (default \"A1\")."
      }
    },
    "required": [
      "name",
      "sourceRange"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'create_pivot_table', {
    name: input.name,
    sourceRange: input.sourceRange,
    sourceWorksheet: input.sourceWorksheet,
    destinationWorksheet: input.destinationWorksheet,
    destinationCell: input.destinationCell,
  });
  return toMcpResult(result);
});

// 45. rebel_office_excel_refresh_pivot_table
registerTool(TOOL_NAMES.excelRefreshPivotTable, {
  title: 'Refresh pivot table',
  description:
    'Refresh a pivot table so it reflects the current source data. Pass `name` to refresh one ' +
    'pivot table, or omit it to refresh every pivot table in the workbook.\n\n' +
    'Use `rebel_office_excel_get_pivot_tables` to list available names.',
  inputSchema: {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "description": "Name of the pivot table to refresh. Omit to refresh all pivot tables."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('excel', 'refresh_pivot_table', {
    name: input.name,
  });
  return toMcpResult(result);
});

// ---------------------------------------------------------------------------
// PowerPoint tool definitions (12 tools)
// ---------------------------------------------------------------------------

// 46. rebel_office_powerpoint_get_slides
registerTool(TOOL_NAMES.pptGetSlides, {
  title: 'List slides',
  description:
    'List all slides in the active presentation with summaries — slide number, layout, title text ' +
    '(if any), and shape count.\n\n' +
    'Use this to understand the presentation structure before making targeted edits. Returns a ' +
    'compact overview; use `rebel_office_powerpoint_get_slide_content` for full details on a ' +
    'specific slide.',
  inputSchema: {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500,
        "default": 100,
        "description": "Maximum slides to return."
      }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'get_slides', { limit: input.limit });
  return toMcpResult(result);
});

// 47. rebel_office_powerpoint_get_slide_content
registerTool(TOOL_NAMES.pptGetSlideContent, {
  title: 'Get slide content',
  description:
    'Get the full content of a specific slide — all shapes, text boxes, images, and their properties ' +
    '(position, size, text content, formatting).\n\n' +
    'Use after `rebel_office_powerpoint_get_slides` to drill into a specific slide for detailed ' +
    'reading or editing.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      }
    },
    "required": [
      "slideIndex"
    ]
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'get_slide_content', { slideIndex: input.slideIndex });
  return toMcpResult(result);
});

// 48. rebel_office_powerpoint_add_slide
registerTool(TOOL_NAMES.pptAddSlide, {
  title: 'Add slide',
  description:
    'Add a new slide to the presentation. Specify a layout and optional initial content (title, ' +
    'subtitle, body text). The slide is inserted at the specified position or at the end.\n\n' +
    'The layout is resolved by name (case-insensitive) against the presentation\'s slide masters — ' +
    'theme layouts work, not just the defaults. Standard PowerPoint layouts: "Title Slide", ' +
    '"Title and Content", "Section Header", "Two Content", "Comparison", "Title Only", "Blank". ' +
    'Use `rebel_office_powerpoint_get_presentation_properties` to list the available layouts, and ' +
    '`rebel_office_powerpoint_apply_layout` to change the layout of an existing slide.',
  inputSchema: {
    "type": "object",
    "properties": {
      "layout": {
        "type": "string",
        "default": "Title and Content",
        "description": "Slide layout name."
      },
      "position": {
        "type": "integer",
        "minimum": 1,
        "description": "Position to insert (1-based). Defaults to end of presentation."
      },
      "title": {
        "type": "string",
        "description": "Title text."
      },
      "subtitle": {
        "type": "string",
        "description": "Subtitle text (for \"Title Slide\" layout)."
      },
      "body": {
        "type": "string",
        "description": "Body text (for \"Title and Content\" layout). Supports newlines for bullet items."
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'add_slide', {
    layout: input.layout, position: input.position,
    title: input.title, subtitle: input.subtitle, body: input.body,
  });
  return toMcpResult(result);
});

// 49. rebel_office_powerpoint_delete_slide
registerTool(TOOL_NAMES.pptDeleteSlide, {
  title: 'Delete slide',
  description:
    'Delete a slide from the presentation by index. **This permanently removes the slide and all ' +
    'its content — cannot be undone.** Returns confirmation.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index to delete (1-based)."
      }
    },
    "required": [
      "slideIndex"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'delete_slide', { slideIndex: input.slideIndex });
  return toMcpResult(result);
});

// 50. rebel_office_powerpoint_reorder_slides
registerTool(TOOL_NAMES.pptReorderSlides, {
  title: 'Reorder slides',
  description:
    'Move a slide to a new position in the presentation. Reorders the slide deck without modifying ' +
    'content. Use for restructuring presentation flow.',
  inputSchema: {
    "type": "object",
    "properties": {
      "fromIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Current slide index (1-based)."
      },
      "toIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Target position (1-based)."
      }
    },
    "required": [
      "fromIndex",
      "toIndex"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'reorder_slides', {
    fromIndex: input.fromIndex, toIndex: input.toIndex,
  });
  return toMcpResult(result);
});

// 51. rebel_office_powerpoint_add_text_box
registerTool(TOOL_NAMES.pptAddTextBox, {
  title: 'Add text box',
  description:
    'Add a text box to a slide at a specified position. Configure font, size, color, and alignment.\n\n' +
    "Text boxes are independent shapes — for content in a slide layout's placeholder, use " +
    '`rebel_office_powerpoint_update_text` instead.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "Text content."
      },
      "position": {
        "type": "object",
        "properties": {
          "left": {
            "type": "number",
            "description": "Left position in points."
          },
          "top": {
            "type": "number",
            "description": "Top position in points."
          },
          "width": {
            "type": "number",
            "description": "Width in points."
          },
          "height": {
            "type": "number",
            "description": "Height in points."
          }
        },
        "required": [
          "left",
          "top",
          "width",
          "height"
        ],
        "description": "Position and dimensions in points."
      },
      "formatting": {
        "type": "object",
        "properties": {
          "fontFamily": {
            "type": "string",
            "description": "Font family."
          },
          "fontSize": {
            "type": "number",
            "minimum": 1,
            "maximum": 400,
            "description": "Font size in points."
          },
          "fontColor": {
            "type": "string",
            "description": "Font hex color."
          },
          "bold": {
            "type": "boolean",
            "description": "Apply bold."
          },
          "italic": {
            "type": "boolean",
            "description": "Apply italic."
          },
          "alignment": {
            "type": "string",
            "enum": [
              "left",
              "center",
              "right"
            ],
            "description": "Text alignment."
          }
        },
        "description": "Text formatting options."
      }
    },
    "required": [
      "slideIndex",
      "text",
      "position"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'add_text_box', {
    slideIndex: input.slideIndex, text: input.text,
    position: input.position, formatting: input.formatting,
  });
  return toMcpResult(result);
});

// 52. rebel_office_powerpoint_add_image
registerTool(TOOL_NAMES.pptAddImage, {
  title: 'Add image to slide',
  description:
    'Add an image to a slide from a file path or base64 data. Position and size the image ' +
    'precisely on the slide. Supports PNG, JPEG, GIF, and SVG formats.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "source": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "filePath",
              "base64"
            ],
            "description": "Source type."
          },
          "filePath": {
            "type": "string",
            "description": "Local file path."
          },
          "base64": {
            "type": "string",
            "description": "Base64-encoded image."
          },
          "mimeType": {
            "type": "string",
            "description": "MIME type for base64 (e.g., \"image/png\")."
          }
        },
        "required": [
          "type"
        ],
        "description": "Image source."
      },
      "position": {
        "type": "object",
        "properties": {
          "left": {
            "type": "number",
            "description": "Left position in points."
          },
          "top": {
            "type": "number",
            "description": "Top position in points."
          },
          "width": {
            "type": "number",
            "description": "Width in points."
          },
          "height": {
            "type": "number",
            "description": "Height in points."
          }
        },
        "required": [
          "left",
          "top",
          "width",
          "height"
        ],
        "description": "Position and dimensions in points."
      }
    },
    "required": [
      "slideIndex",
      "source",
      "position"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'add_image', {
    slideIndex: input.slideIndex, source: input.source, position: input.position,
  });
  return toMcpResult(result);
});

// 53. rebel_office_powerpoint_add_shape
registerTool(TOOL_NAMES.pptAddShape, {
  title: 'Add shape',
  description:
    'Add a geometric shape to a slide. Supports rectangles, circles, arrows, stars, callouts, ' +
    'and more. Shapes can contain text and have fill colors and line styles.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "shapeType": {
        "type": "string",
        "minLength": 1,
        "description": "Shape type (e.g., \"rectangle\", \"ellipse\", \"roundedRectangle\", \"triangle\", \"rightArrow\", \"star5\", \"callout1\")."
      },
      "position": {
        "type": "object",
        "properties": {
          "left": {
            "type": "number",
            "description": "Left position in points."
          },
          "top": {
            "type": "number",
            "description": "Top position in points."
          },
          "width": {
            "type": "number",
            "description": "Width in points."
          },
          "height": {
            "type": "number",
            "description": "Height in points."
          }
        },
        "required": [
          "left",
          "top",
          "width",
          "height"
        ],
        "description": "Position and dimensions in points."
      },
      "text": {
        "type": "string",
        "description": "Text inside the shape."
      },
      "fillColor": {
        "type": "string",
        "description": "Hex fill color."
      },
      "lineColor": {
        "type": "string",
        "description": "Hex line color."
      },
      "lineWidth": {
        "type": "number",
        "minimum": 0,
        "description": "Line width in points."
      }
    },
    "required": [
      "slideIndex",
      "shapeType",
      "position"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'add_shape', {
    slideIndex: input.slideIndex, shapeType: input.shapeType, position: input.position,
    text: input.text, fillColor: input.fillColor, lineColor: input.lineColor, lineWidth: input.lineWidth,
  });
  return toMcpResult(result);
});

// 54. rebel_office_powerpoint_update_text
registerTool(TOOL_NAMES.pptUpdateText, {
  title: 'Update text in shape',
  description:
    'Update existing text in a shape or placeholder on a slide. Identify the target by shape ID ' +
    '(from `rebel_office_powerpoint_get_slide_content`) or by placeholder type ("title", "subtitle", ' +
    '"body"). Use this to modify existing content rather than adding new shapes.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "shapeId",
              "placeholder"
            ],
            "description": "Target type."
          },
          "shapeId": {
            "type": "string",
            "description": "Shape ID from rebel_office_powerpoint_get_slide_content."
          },
          "placeholder": {
            "type": "string",
            "enum": [
              "title",
              "subtitle",
              "body"
            ],
            "description": "Placeholder type."
          }
        },
        "required": [
          "type"
        ],
        "description": "Which shape or placeholder to update."
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "description": "New text content."
      },
      "formatting": {
        "type": "object",
        "properties": {
          "fontFamily": {
            "type": "string",
            "description": "Font family."
          },
          "fontSize": {
            "type": "number",
            "minimum": 1,
            "maximum": 400,
            "description": "Font size in points."
          },
          "fontColor": {
            "type": "string",
            "description": "Font hex color."
          },
          "bold": {
            "type": "boolean",
            "description": "Apply bold."
          },
          "italic": {
            "type": "boolean",
            "description": "Apply italic."
          },
          "alignment": {
            "type": "string",
            "enum": [
              "left",
              "center",
              "right"
            ],
            "description": "Text alignment."
          }
        },
        "description": "Text formatting options."
      }
    },
    "required": [
      "slideIndex",
      "target",
      "text"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'update_text', {
    slideIndex: input.slideIndex, target: input.target, text: input.text, formatting: input.formatting,
  });
  return toMcpResult(result);
});

// 55. rebel_office_powerpoint_get_speaker_notes
registerTool(TOOL_NAMES.pptGetSpeakerNotes, {
  title: 'Read speaker notes',
  description:
    'Read speaker notes for one or all slides. Returns the notes text for each slide.\n\n' +
    "Speaker notes are the presenter's script — often used for meeting talking points, cue cards, " +
    'or detailed explanations not shown to the audience.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Specific slide (1-based). Omit to get notes for all slides."
      }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'get_speaker_notes', { slideIndex: input.slideIndex });
  return toMcpResult(result);
});

// 56. rebel_office_powerpoint_set_speaker_notes
registerTool(TOOL_NAMES.pptSetSpeakerNotes, {
  title: 'Set speaker notes',
  description:
    'Set or update the speaker notes for a slide. Replaces any existing notes.\n\n' +
    'Use for adding presenter talking points, meeting prep notes, or detailed explanations. ' +
    'Notes support plain text with basic line breaks.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "notes": {
        "type": "string",
        "minLength": 1,
        "description": "Speaker notes text."
      }
    },
    "required": [
      "slideIndex",
      "notes"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'set_speaker_notes', {
    slideIndex: input.slideIndex, notes: input.notes,
  });
  return toMcpResult(result);
});

// 57. rebel_office_powerpoint_get_presentation_properties
registerTool(TOOL_NAMES.pptGetPresentationProperties, {
  title: 'Get presentation properties',
  description:
    "Get the presentation's metadata — title, slide dimensions, slide count, layout names, and " +
    'theme information. Use to understand the presentation context before making changes.',
  inputSchema: {
    "type": "object",
    "properties": {}
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const result = await sidecarRequest('powerpoint', 'get_presentation_properties', {});
  return toMcpResult(result);
});

// 58. rebel_office_powerpoint_apply_layout
registerTool(TOOL_NAMES.pptApplyLayout, {
  title: 'Apply layout to slide',
  description:
    'Change the layout of an existing slide — e.g. switch a slide from "Title and Content" to ' +
    '"Two Content". The layout is resolved by name (case-insensitive) against the ' +
    "presentation's slide masters; theme layouts work, not just the defaults.\n\n" +
    'Use `rebel_office_powerpoint_get_presentation_properties` to list the available layouts. ' +
    'Requires a PowerPoint version with layout support (PowerPointApi 1.8+).',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "layout": {
        "type": "string",
        "minLength": 1,
        "description": "Layout name, e.g. \"Title and Content\"."
      }
    },
    "required": [
      "slideIndex",
      "layout"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'apply_layout', {
    slideIndex: input.slideIndex, layout: input.layout,
  });
  return toMcpResult(result);
});

// 59. rebel_office_powerpoint_delete_shape
registerTool(TOOL_NAMES.pptDeleteShape, {
  title: 'Delete shape',
  description:
    'Delete a shape from a slide, identified by shape ID or by placeholder/name match.\n\n' +
    'Use `rebel_office_powerpoint_get_slide_content` to list a slide\'s shapes and their IDs first. ' +
    'This cannot be undone from the API — delete with care.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "shapeId",
              "placeholder"
            ],
            "description": "Identify the shape by its ID, or by placeholder/name (case-insensitive contains-match)."
          },
          "shapeId": {
            "type": "string",
            "description": "Shape ID (for shapeId)."
          },
          "placeholder": {
            "type": "string",
            "description": "Placeholder or shape name to match (for placeholder), e.g. \"title\", \"content\"."
          }
        },
        "required": [
          "type"
        ],
        "description": "Which shape to delete."
      }
    },
    "required": [
      "slideIndex",
      "target"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'delete_shape', {
    slideIndex: input.slideIndex, target: input.target,
  });
  return toMcpResult(result);
});

// 60. rebel_office_powerpoint_format_shape
registerTool(TOOL_NAMES.pptFormatShape, {
  title: 'Format shape',
  description:
    'Format an existing shape: fill color, line color/width, position (left/top), size ' +
    '(width/height, in points), or rename it. Shapes are identified by shape ID or by ' +
    'placeholder/name match.\n\n' +
    'Use `rebel_office_powerpoint_get_slide_content` to list a slide\'s shapes and their IDs first.',
  inputSchema: {
    "type": "object",
    "properties": {
      "slideIndex": {
        "type": "integer",
        "minimum": 1,
        "description": "Slide index (1-based)."
      },
      "target": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "shapeId",
              "placeholder"
            ],
            "description": "Identify the shape by its ID, or by placeholder/name (case-insensitive contains-match)."
          },
          "shapeId": {
            "type": "string",
            "description": "Shape ID (for shapeId)."
          },
          "placeholder": {
            "type": "string",
            "description": "Placeholder or shape name to match (for placeholder)."
          }
        },
        "required": [
          "type"
        ],
        "description": "Which shape to format."
      },
      "formatting": {
        "type": "object",
        "properties": {
          "fillColor": {
            "type": "string",
            "description": "Fill color as HTML color (e.g. \"#4472C4\")."
          },
          "lineColor": {
            "type": "string",
            "description": "Line (border) color as HTML color."
          },
          "lineWidth": {
            "type": "number",
            "exclusiveMinimum": 0,
            "description": "Line (border) width in points."
          },
          "left": {
            "type": "number",
            "description": "Distance from the left edge of the slide, in points."
          },
          "top": {
            "type": "number",
            "description": "Distance from the top edge of the slide, in points."
          },
          "width": {
            "type": "number",
            "exclusiveMinimum": 0,
            "description": "Shape width in points."
          },
          "height": {
            "type": "number",
            "exclusiveMinimum": 0,
            "description": "Shape height in points."
          },
          "name": {
            "type": "string",
            "description": "Rename the shape."
          }
        },
        "description": "Formatting to apply. At least one property is required."
      }
    },
    "required": [
      "slideIndex",
      "target",
      "formatting"
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const result = await sidecarRequest('powerpoint', 'format_shape', {
    slideIndex: input.slideIndex, target: input.target, formatting: input.formatting,
  });
  return toMcpResult(result);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === __filename;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const transport = new StdioServerTransport();

  server
    .connect(transport)
    .then(() => {
      console.error('[RebelOffice] Server started');
    })
    .catch((error) => {
      console.error('[RebelOffice] Failed to start', error);
      process.exit(1);
    });
}

export const __test = {
  ensureSidecar,
  loadSidecarState,
  loopbackHttpsAgent,
  loopbackHttpsRequest,
  isLoopbackHostname,
  toMcpResult,
  stampUntrustedSource,
  sidecarRequest,
  packageVersion: PACKAGE_VERSION,
  setSpawnSidecarAndWaitForTests(fn: typeof defaultSpawnSidecarAndWait) {
    spawnSidecarAndWait = fn;
  },
  setBeforeLockedStateCheckForTests(fn: (() => Promise<void>) | null) {
    beforeLockedStateCheckForTests = fn;
  },
  resetForTests() {
    sidecarChild = null;
    sidecarStarting = null;
    beforeLockedStateCheckForTests = null;
    spawnSidecarAndWait = defaultSpawnSidecarAndWait;
    cleanupLock();
    cleanupLastFailureFile();
    if (stateFilePath) {
      try { fs.unlinkSync(stateFilePath); } catch { /* ignore */ }
    }
  },
};
