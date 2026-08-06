import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * bridge.ts captures MCP_HOST_BRIDGE_STATE at import time, so each test
 * stubs the env var and re-imports the module fresh.
 */
async function importBridge(stateContents: string | null): Promise<{
  bridgeRequest: (
    urlPath: string,
    body?: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string; username?: string }>;
  statePath: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-bridge-test-'));
  const statePath = path.join(dir, 'bridge.json');
  if (stateContents !== null) {
    fs.writeFileSync(statePath, stateContents, { mode: 0o600 });
  }
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', stateContents === null ? '' : statePath);
  vi.resetModules();
  const { bridgeRequest } = await import('../src/bridge.js');
  return { bridgeRequest, statePath };
}

describe('Bridge state validation — Outreach MCP server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('refuses a hostile port value instead of interpolating it into the URL', async () => {
    // A string port like "8080@evil.example" would make 127.0.0.1:8080 the
    // userinfo and evil.example the host, exfiltrating the bridge token.
    const { bridgeRequest } = await importBridge(
      JSON.stringify({ port: '8080@evil.example', token: 'bridge-token' }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await bridgeRequest('/mcp/configure');
    expect(result).toEqual({ success: false, error: 'Bridge not available' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses out-of-range and non-integer ports', async () => {
    for (const port of [0, 99999, 80.5]) {
      const { bridgeRequest } = await importBridge(JSON.stringify({ port, token: 'bridge-token' }));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await bridgeRequest('/mcp/configure');
      expect(result).toEqual({ success: false, error: 'Bridge not available' });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('accepts a well-formed state and calls the loopback bridge with its token', async () => {
    const { bridgeRequest } = await importBridge(JSON.stringify({ port: 9999, token: 'bridge-token' }));
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, username: 'jane@example.com' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await bridgeRequest('/mcp/configure');
    expect(result).toEqual({ success: true, username: 'jane@example.com' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/mcp/configure');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bridge-token');
  });
});
