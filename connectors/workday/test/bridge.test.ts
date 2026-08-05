/**
 * Adversarial coverage for the host-bridge state file read: the path is
 * host-supplied process configuration whose production location sits outside
 * both approved file roots, so the file is treated as hostile input —
 * lexical path hygiene, open-once + fstat + read-through-fd, a size cap, and
 * strict shape validation. Every failure must be observable via a stderr
 * warning, never silently collapsed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const BASE_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
};

/** Run configure against a bridge-state path and capture stderr warnings. */
async function runConfigureWithBridgePath(bridgeStatePath: string) {
  // Token exchange + API probe succeed so configure always reaches the
  // bridge call — the bridge-state read is the variable under test.
  // (Registered per-call: mswServer.resetHandlers() runs after each test.)
  mswServer.use(
    http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
    http.get(`${API_BASE}/workers`, async () =>
      HttpResponse.json({ data: [], total: 0 }),
    ),
  );

  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const testClient = await createTestClient({
      env: { ...BASE_ENV, MCP_HOST_BRIDGE_STATE: bridgeStatePath },
    });
    const result = await testClient.callTool('configure_workday_credentials', {
      host: MOCK_HOST,
      tenant: MOCK_TENANT,
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });
    const warnings = consoleSpy.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((line) => line.startsWith('[Workday]'));
    const json = result.json as Record<string, unknown>;
    await testClient.close();
    return { json, warnings };
  } finally {
    consoleSpy.mockRestore();
  }
}

describe('bridge state file hardening', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function makeTmpDir() {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-bridge-test-'));
    return { fs, path };
  }

  it('malformed JSON: observable warning + bridge unavailable', async () => {
    const { fs, path } = await makeTmpDir();
    try {
      const statePath = path.join(tmpDir, 'bridge-state.json');
      fs.writeFileSync(statePath, 'this is not json {');

      const { json, warnings } = await runConfigureWithBridgePath(statePath);
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(warnings.some((line) => line.includes('Failed to load bridge state file'))).toBe(true);
    } finally {
      (await import('fs')).rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalid shape (port not an integer): observable warning + bridge unavailable', async () => {
    const { fs, path } = await makeTmpDir();
    try {
      const statePath = path.join(tmpDir, 'bridge-state.json');
      fs.writeFileSync(statePath, JSON.stringify({ port: 'not-a-port', token: 'test-token' }));

      const { json, warnings } = await runConfigureWithBridgePath(statePath);
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(warnings.some((line) => line.includes('"port" is not an integer'))).toBe(true);
    } finally {
      (await import('fs')).rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalid shape (empty token): observable warning + bridge unavailable', async () => {
    const { fs, path } = await makeTmpDir();
    try {
      const statePath = path.join(tmpDir, 'bridge-state.json');
      fs.writeFileSync(statePath, JSON.stringify({ port: 19876, token: '' }));

      const { json, warnings } = await runConfigureWithBridgePath(statePath);
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(warnings.some((line) => line.includes('"token" is not a non-empty string'))).toBe(true);
    } finally {
      (await import('fs')).rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('relative path is refused with an observable warning', async () => {
    const { json, warnings } = await runConfigureWithBridgePath('bridge-state.json');
    expect(json.ok).toBe(false);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(warnings.some((line) => line.includes('not an absolute, normalized path'))).toBe(true);
  });

  it('path with a traversal segment is refused with an observable warning', async () => {
    const os = await import('os');
    // Literal '..' segment — path.join would normalize it away.
    const traversal = `${os.tmpdir()}/workday-bridge-test/../bridge-state.json`;

    const { json, warnings } = await runConfigureWithBridgePath(traversal);
    expect(json.ok).toBe(false);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(warnings.some((line) => line.includes('not an absolute, normalized path'))).toBe(true);
  });

  it('oversized state file is refused with an observable warning', async () => {
    const { fs, path } = await makeTmpDir();
    try {
      const statePath = path.join(tmpDir, 'bridge-state.json');
      fs.writeFileSync(statePath, `{"port":19876,"token":"${'x'.repeat(128 * 1024)}"}`);

      const { json, warnings } = await runConfigureWithBridgePath(statePath);
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(warnings.some((line) => line.includes('exceeds'))).toBe(true);
    } finally {
      (await import('fs')).rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('directory instead of a file is refused with an observable warning', async () => {
    const { fs, path } = await makeTmpDir();
    try {
      const dirPath = path.join(tmpDir, 'bridge-state-dir');
      fs.mkdirSync(dirPath);

      const { json, warnings } = await runConfigureWithBridgePath(dirPath);
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(warnings.some((line) => line.includes('not a regular file'))).toBe(true);
    } finally {
      (await import('fs')).rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
