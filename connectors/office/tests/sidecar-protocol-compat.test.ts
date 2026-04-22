/**
 * Stage 8 — protocol and error compat tests.
 *
 * Office's sidecar now imports `ConnectionManager`, `CommandRouter`, and
 * `ErrorCode` from `@core/appBridge/*`. These tests guard the adapter layer
 * that keeps the in-the-wild Office add-in working:
 *
 *   - Legacy `{ type: 'register', app, version }` → upgraded
 *     `{ type: 'register', appId: 'office-<app>', protocolVersion, appVersion,
 *     capabilities }` (R26 backwards-compat).
 *   - `isOfficeApp()` / `toOfficeAppId()` / `fromOfficeAppId()` narrowing.
 *   - `SidecarHttpError.code` is the shared `ErrorCode` type.
 *   - Office-specific `create*Error` helpers preserve their branded messages.
 *   - End-to-end WebSocket handshake still works when the client sends the
 *     legacy register shape (`waitForConnection` helper completes).
 */

import * as fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/shared/appBridge/shared/errors.js';
import {
  adaptLegacyRegisterMessage,
  fromOfficeAppId,
  isLegacyOfficeRegisterMessage,
  isOfficeApp,
  normaliseRegisterMessage,
  OFFICE_APPS,
  toOfficeAppId,
  validateRegisterMessage,
} from '../src/shared/office/protocol.js';
import {
  createAddinDisconnectedError,
  createAppNotConnectedError,
  createCommandTimeoutError,
  createInvalidRequestError,
  createUnauthorizedError,
  fromAppBridgeError,
  isAppBridgeError,
  SIDECAR_ERROR_CODES,
  SidecarHttpError,
} from '../src/shared/office/errors.js';
import { startOfficeSidecar, type OfficeSidecar } from '../src/sidecar/index.js';

// ---------------------------------------------------------------------------
// Test helpers (copied from sidecar.test.ts — tests need their own HTTPS
// fetch / WS connect utilities because the sidecar uses self-signed certs).
// ---------------------------------------------------------------------------

async function fetchHttps(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options.method ?? 'GET',
        headers: options.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(body) as unknown),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function connectWebSocket(port: number): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
      rejectUnauthorized: false,
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForConnection(baseUrl: string, app: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetchHttps(`${baseUrl}/health`);
    const payload = (await response.json()) as { connected: Record<string, boolean> };
    if (payload.connected?.[app] === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${app} registration`);
}

const cleanupServers: OfficeSidecar[] = [];
const cleanupDirs: string[] = [];
const cleanupSockets: WebSocket[] = [];

async function startTestServer(): Promise<{
  sidecar: OfficeSidecar;
  baseUrl: string;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-proto-compat-'));
  cleanupDirs.push(stateDir);

  const sidecar = await startOfficeSidecar({
    stateDirectory: stateDir,
    port: 0,
    installToWefFolders: false,
  });
  cleanupServers.push(sidecar);

  return {
    sidecar,
    baseUrl: `https://127.0.0.1:${sidecar.port}`,
  };
}

afterEach(async () => {
  while (cleanupSockets.length > 0) {
    const socket = cleanupSockets.pop();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  while (cleanupServers.length > 0) {
    const server = cleanupServers.pop();
    if (server) {
      await server.stop();
    }
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 8 — register message adapter', () => {
  it('adaptLegacyRegisterMessage upgrades { app, version } to { appId, appVersion, ... }', () => {
    const upgraded = adaptLegacyRegisterMessage({
      type: 'register',
      app: 'word',
      version: '1.0.0',
    });

    expect(upgraded).toEqual({
      type: 'register',
      appId: 'office-word',
      protocolVersion: '1.0',
      appVersion: '1.0.0',
      capabilities: [],
    });
  });

  it('adaptLegacyRegisterMessage handles all three Office hosts', () => {
    for (const app of OFFICE_APPS) {
      const upgraded = adaptLegacyRegisterMessage({
        type: 'register',
        app,
        version: '2.3.4',
      });
      expect(upgraded.appId).toBe(`office-${app}`);
      expect(upgraded.appVersion).toBe('2.3.4');
    }
  });

  it('isLegacyOfficeRegisterMessage distinguishes shapes', () => {
    expect(
      isLegacyOfficeRegisterMessage({
        type: 'register',
        app: 'word',
        version: '1.0.0',
      }),
    ).toBe(true);
    expect(
      isLegacyOfficeRegisterMessage({
        type: 'register',
        appId: 'office-word',
        protocolVersion: '1.0',
      }),
    ).toBe(false);
  });

  it('validateRegisterMessage accepts the legacy shape', () => {
    const valid = validateRegisterMessage({
      type: 'register',
      app: 'excel',
      version: '16.77',
    });
    expect(valid).not.toBeNull();
    expect(valid?.appId).toBe('office-excel');
    expect(valid?.appVersion).toBe('16.77');
  });

  it('validateRegisterMessage accepts the upgraded shape', () => {
    const valid = validateRegisterMessage({
      type: 'register',
      appId: 'office-powerpoint',
      protocolVersion: '1.0',
      appVersion: '16.77',
      clientId: 'abc123',
      capabilities: [{ id: 'read_slides' }],
    });
    expect(valid).not.toBeNull();
    expect(valid?.appId).toBe('office-powerpoint');
    expect(valid?.clientId).toBe('abc123');
    expect(valid?.capabilities).toEqual([{ id: 'read_slides' }]);
  });

  it('validateRegisterMessage rejects malformed payloads', () => {
    expect(validateRegisterMessage(null)).toBeNull();
    expect(validateRegisterMessage({ type: 'auth', token: 't' })).toBeNull();
    expect(
      validateRegisterMessage({ type: 'register', app: 'wordish', version: '1.0' }),
    ).toBeNull();
    expect(
      validateRegisterMessage({ type: 'register', app: 'word', version: '   ' }),
    ).toBeNull();
    expect(
      validateRegisterMessage({ type: 'register', appId: 'browser-extension' }),
    ).toBeNull();
    expect(
      validateRegisterMessage({ type: 'register', appId: 'office-nope' }),
    ).toBeNull();
  });

  it('normaliseRegisterMessage is idempotent on the upgraded shape', () => {
    const upgraded = {
      type: 'register' as const,
      appId: 'office-word' as const,
      protocolVersion: '1.0',
      appVersion: '1.0.0',
      capabilities: [],
    };
    expect(normaliseRegisterMessage(upgraded)).toEqual(upgraded);
  });
});

describe('Stage 8 — OfficeApp narrowing', () => {
  it('isOfficeApp returns true for every OFFICE_APPS member', () => {
    for (const app of OFFICE_APPS) {
      expect(isOfficeApp(app)).toBe(true);
    }
  });

  it('isOfficeApp rejects non-Office identifiers', () => {
    expect(isOfficeApp('browser-extension')).toBe(false);
    expect(isOfficeApp('office-word')).toBe(false); // the upgraded form, not bare
    expect(isOfficeApp('')).toBe(false);
    expect(isOfficeApp(null)).toBe(false);
    expect(isOfficeApp(42)).toBe(false);
  });

  it('toOfficeAppId / fromOfficeAppId round-trip', () => {
    for (const app of OFFICE_APPS) {
      const id = toOfficeAppId(app);
      expect(id).toBe(`office-${app}`);
      expect(fromOfficeAppId(id)).toBe(app);
    }
  });
});

describe('Stage 8 — SidecarHttpError + ErrorCode', () => {
  it('SidecarHttpError.code is the shared ErrorCode', () => {
    const err = createUnauthorizedError();
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(err).toBeInstanceOf(SidecarHttpError);
    expect(err).toBeInstanceOf(Error);
  });

  it('createAppNotConnectedError preserves Office-specific message per host', () => {
    const wordErr = createAppNotConnectedError('word');
    expect(wordErr.status).toBe(503);
    expect(wordErr.code).toBe(ErrorCode.APP_NOT_CONNECTED);
    expect(wordErr.app).toBe('word');
    expect(wordErr.message).toBe(
      "Word isn't connected. Open a document in Microsoft Word with the Rebel add-in enabled, then try again.",
    );

    const excelErr = createAppNotConnectedError('excel');
    expect(excelErr.message).toContain('Excel');
    expect(excelErr.message).toContain('workbook');

    const pptErr = createAppNotConnectedError('powerpoint');
    expect(pptErr.message).toContain('PowerPoint');
    expect(pptErr.message).toContain('presentation');
  });

  it('createAddinDisconnectedError and createCommandTimeoutError use Office messages', () => {
    const disconnected = createAddinDisconnectedError('word');
    expect(disconnected.code).toBe(ErrorCode.ADDIN_DISCONNECTED);
    expect(disconnected.status).toBe(503);
    expect(disconnected.message).toContain('Word');
    expect(disconnected.message).toContain('reopen');

    const timeout = createCommandTimeoutError('excel');
    expect(timeout.code).toBe(ErrorCode.COMMAND_TIMEOUT);
    expect(timeout.status).toBe(504);
    expect(timeout.message).toContain('timed out');
  });

  it('createInvalidRequestError uses the preserved INVALID_REQUEST wire code', () => {
    const err = createInvalidRequestError('Bad body');
    expect(err.status).toBe(400);
    expect(err.code).toBe(ErrorCode.INVALID_REQUEST);
    expect(err.message).toBe('Bad body');
  });

  it('SIDECAR_ERROR_CODES still maps to the same wire codes the add-in/MCP expect', () => {
    expect(SIDECAR_ERROR_CODES.unauthorized).toBe('UNAUTHORIZED');
    expect(SIDECAR_ERROR_CODES.invalidRequest).toBe('INVALID_REQUEST');
    expect(SIDECAR_ERROR_CODES.appNotConnected).toBe('APP_NOT_CONNECTED');
    expect(SIDECAR_ERROR_CODES.addinDisconnected).toBe('ADDIN_DISCONNECTED');
    expect(SIDECAR_ERROR_CODES.commandTimeout).toBe('COMMAND_TIMEOUT');
    expect(SIDECAR_ERROR_CODES.internalError).toBe('INTERNAL_ERROR');
  });
});

describe('Stage 8 — fromAppBridgeError translation', () => {
  it('isAppBridgeError accepts the core AppBridgeError shape', () => {
    expect(
      isAppBridgeError({
        code: ErrorCode.APP_NOT_CONNECTED,
        message: 'nope',
        status: 503,
      }),
    ).toBe(true);
    expect(isAppBridgeError(null)).toBe(false);
    expect(isAppBridgeError(new Error('plain'))).toBe(false);
    expect(isAppBridgeError({ code: 'X' })).toBe(false);
  });

  it('translates APP_NOT_CONNECTED to Office-branded message', () => {
    const core = {
      code: ErrorCode.APP_NOT_CONNECTED,
      message: 'App is not connected.',
      status: 503,
    };
    const office = fromAppBridgeError(core, 'word');
    expect(office).toBeInstanceOf(SidecarHttpError);
    expect(office.code).toBe(ErrorCode.APP_NOT_CONNECTED);
    expect(office.app).toBe('word');
    expect(office.message).toContain('Word');
    expect(office.message).toContain('Microsoft Word');
  });

  it('translates ADDIN_DISCONNECTED and COMMAND_TIMEOUT with Office messages', () => {
    const disconnected = fromAppBridgeError(
      {
        code: ErrorCode.ADDIN_DISCONNECTED,
        message: 'core message',
        status: 503,
      },
      'excel',
    );
    expect(disconnected.message).toContain('Excel');
    expect(disconnected.message).toContain('reopen');

    const timeout = fromAppBridgeError(
      {
        code: ErrorCode.COMMAND_TIMEOUT,
        message: 'core message',
        status: 504,
      },
      'powerpoint',
    );
    expect(timeout.message).toContain('timed out');
  });

  it('passes through unmapped codes with the core-supplied message', () => {
    const other = fromAppBridgeError(
      {
        code: ErrorCode.RATE_LIMITED,
        message: 'slow down',
        status: 429,
      },
      'word',
    );
    expect(other.code).toBe(ErrorCode.RATE_LIMITED);
    expect(other.status).toBe(429);
    expect(other.message).toBe('slow down');
  });
});

describe('Stage 8 — end-to-end legacy register handshake', () => {
  it('accepts the legacy { type, app, version } register shape over WS', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    cleanupSockets.push(socket);

    socket.send(JSON.stringify({ type: 'auth', token: sidecar.token }));
    socket.send(
      JSON.stringify({ type: 'register', app: 'word', version: '1.0.0' }),
    );

    await waitForConnection(baseUrl, 'word');

    const health = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };
    expect(health.connected.word).toBe(true);
    expect(health.connected.excel).toBe(false);
    expect(health.connected.powerpoint).toBe(false);
  });

  it('accepts the upgraded { type, appId, appVersion } register shape over WS', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    cleanupSockets.push(socket);

    socket.send(JSON.stringify({ type: 'auth', token: sidecar.token }));
    socket.send(
      JSON.stringify({
        type: 'register',
        appId: 'office-excel',
        protocolVersion: '1.0',
        appVersion: '16.77',
      }),
    );

    await waitForConnection(baseUrl, 'excel');

    const health = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: Record<string, boolean>;
    };
    expect(health.connected.excel).toBe(true);
  });
});
