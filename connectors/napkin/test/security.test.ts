/**
 * Security tests — VAL-NAPKIN-001..009
 *
 * Covers the Bearer-leak hardening for `napkin_download_visual`:
 *  - Hard-coded host allow-list (api.napkin.ai).
 *  - HTTPS-only, userinfo rejection, private/loopback/reserved-IP rejection.
 *  - Defence-in-depth: the Authorization: Bearer header is NEVER attached
 *    when the URL host is not on the allow-list, even if the validation
 *    were somehow bypassed.
 *  - Tool description nudges the LLM toward Napkin-only URLs.
 *  - Existing happy-path download behaviour is preserved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createNapkinHandlers } from './helpers/napkin-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, mockRequestId } from './fixtures/napkin-data.js';

interface DownloadResult {
  success?: boolean;
  ok?: boolean;
  error?: string;
  code?: string;
  file_path?: string;
  size_bytes?: number;
}

describe('VAL-NAPKIN — napkin_download_visual Bearer-leak hardening', () => {
  let testClient: McpTestClient;
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  const downloadedFiles: string[] = [];
  const createdDirs: string[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    vi.unstubAllEnvs();
    for (const f of downloadedFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    downloadedFiles.length = 0;
    for (const d of createdDirs.reverse()) {
      try {
        if (fs.existsSync(d)) fs.rmdirSync(d, { recursive: true } as fs.RmDirOptions);
      } catch { /* ignore */ }
    }
    createdDirs.length = 0;
  });

  /**
   * Helper: count fetch calls whose URL host matches a predicate AND that
   * had an Authorization header set on the request init.
   */
  function authedCallsTo(predicate: (host: string) => boolean): number {
    if (!fetchSpy) return 0;
    let count = 0;
    for (const call of fetchSpy.mock.calls) {
      const [input, init] = call as [unknown, RequestInit | undefined];
      let host = '';
      try {
        if (typeof input === 'string') host = new URL(input).host;
        else if (input instanceof URL) host = input.host;
        else if (input && typeof (input as Request).url === 'string') host = new URL((input as Request).url).host;
      } catch { /* ignore */ }
      if (!predicate(host)) continue;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authHeader = headers.Authorization ?? headers.authorization ?? '';
      if (typeof authHeader === 'string' && /^Bearer\b/.test(authHeader)) count++;
    }
    return count;
  }

  it('VAL-NAPKIN-001 — allow-listed host succeeds and Bearer header is sent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-sec-'));
    createdDirs.push(tmpDir);

    mswServer.use(...createNapkinHandlers());

    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: tmpDir,
      },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: `https://api.napkin.ai/v1/visual/${mockRequestId}/file/output.svg`,
      filename: 'allow-listed',
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as DownloadResult;
    expect(data.success).toBe(true);
    expect(data.file_path && fs.existsSync(data.file_path)).toBe(true);
    if (data.file_path) downloadedFiles.push(data.file_path);

    // Exactly one fetch to api.napkin.ai with Authorization: Bearer <key>
    expect(authedCallsTo((h) => h === 'api.napkin.ai')).toBe(1);
  });

  it('VAL-NAPKIN-002 — non-allow-listed host is rejected and fetch is NOT called', async () => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: os.tmpdir(),
      },
    });

    fetchSpy?.mockClear();

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: 'https://attacker.example/x',
      filename: 'evil',
    });

    expect(result.isError).toBe(true);
    const data = result.json as DownloadResult;
    expect(data.ok ?? data.success).toBeFalsy();
    // Error message identifies host as not allow-listed
    expect((data.error ?? result.text ?? '').toLowerCase()).toMatch(/allow|napkin|host/);

    // Crucial: zero fetch calls with that host
    const calls = (fetchSpy?.mock.calls ?? []).filter(([input]) => {
      try {
        const u = typeof input === 'string' ? new URL(input) : (input instanceof URL ? input : new URL((input as Request).url));
        return u.host === 'attacker.example';
      } catch { return false; }
    });
    expect(calls.length).toBe(0);
  });

  it('VAL-NAPKIN-003 — Bearer is NEVER transmitted to non-allow-listed hosts (defence-in-depth)', async () => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: os.tmpdir(),
      },
    });

    const attackerUrls = [
      'https://attacker.example/exfil',
      'https://api.napkin.ai.attacker.example/x',
      'https://evil.com/steal',
      'https://napkin.ai.evil.example/x',
    ];

    for (const url of attackerUrls) {
      const result = await testClient.callTool('napkin_download_visual', { file_url: url });
      expect(result.isError).toBe(true);
    }

    // Defence-in-depth assertion: across every fetch the spy saw, none of the
    // calls to a non-allow-listed host carried a Bearer Authorization header.
    expect(authedCallsTo((h) => h !== 'api.napkin.ai')).toBe(0);
  });

  it.each([
    ['http://api.napkin.ai/x', 'http'],
    ['ftp://api.napkin.ai/x', 'ftp'],
    ['file:///etc/passwd', 'file'],
    ['data:text/plain,hello', 'data'],
  ])('VAL-NAPKIN-004 — non-HTTPS scheme rejected (%s)', async (url, _scheme) => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: os.tmpdir(),
      },
    });

    fetchSpy?.mockClear();

    const result = await testClient.callTool('napkin_download_visual', { file_url: url });
    expect(result.isError).toBe(true);

    // No fetch was issued to honour the bad URL
    for (const call of fetchSpy?.mock.calls ?? []) {
      const [input] = call as [unknown];
      try {
        const u = typeof input === 'string' ? new URL(input) : (input instanceof URL ? input : new URL((input as Request).url));
        // Only allow same-origin status-API hits to the legit base if any (none expected),
        // and they MUST be https.
        expect(u.protocol).toBe('https:');
      } catch { /* malformed URL shouldn't have been issued */ }
    }
  });

  it('VAL-NAPKIN-005 — URL with userinfo is rejected', async () => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: os.tmpdir(),
      },
    });

    fetchSpy?.mockClear();

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: 'https://attacker@api.napkin.ai/v1/visual/x/file/y.svg',
    });

    expect(result.isError).toBe(true);
    const data = result.json as DownloadResult;
    expect((data.error ?? result.text ?? '').toLowerCase()).toMatch(/userinfo|credential|user|password/);
    expect(fetchSpy?.mock.calls ?? []).toHaveLength(0);
  });

  it.each([
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://10.0.0.5/x',
    'https://172.16.0.1/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://0.0.0.0/x',
    'https://[::1]/x',
  ])('VAL-NAPKIN-006 — private/loopback/reserved IP literal rejected (%s)', async (url) => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: os.tmpdir(),
      },
    });

    fetchSpy?.mockClear();

    const result = await testClient.callTool('napkin_download_visual', { file_url: url });
    expect(result.isError).toBe(true);
    expect(fetchSpy?.mock.calls ?? []).toHaveLength(0);
  });

  it('VAL-NAPKIN-007 — allow-list is hard-coded in source, not env-overridable', async () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const downloadSrc = fs.readFileSync(path.join(srcDir, 'client.ts'), 'utf8');

    // Hard-coded literal allow-list constant exists somewhere in the connector
    // source (we keep it in client.ts alongside downloadFile by convention).
    expect(downloadSrc).toMatch(/api\.napkin\.ai/);

    // No env-controlled allow-list (e.g. NAPKIN_DOWNLOAD_ALLOWED_HOSTS / NAPKIN_ALLOW_HOSTS).
    function readAllSrcFiles(dir: string): string {
      let out = '';
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out += readAllSrcFiles(full);
        else if (entry.isFile() && full.endsWith('.ts')) out += fs.readFileSync(full, 'utf8');
      }
      return out;
    }
    const allSrc = readAllSrcFiles(srcDir);
    expect(allSrc).not.toMatch(/process\.env\.[A-Z_]*ALLOW[A-Z_]*HOST/);
    expect(allSrc).not.toMatch(/process\.env\.NAPKIN_(DOWNLOAD_)?ALLOWED_HOSTS/);
  });

  it('VAL-NAPKIN-008 — tool description communicates the allow-list constraint', async () => {
    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const tools = await testClient.client.listTools();
    const dl = tools.tools.find((t) => t.name === 'napkin_download_visual');
    expect(dl).toBeDefined();
    const desc = (dl?.description ?? '').toLowerCase();
    expect(desc).toContain('napkin');
    // Communicates allow-list / refusal of non-Napkin hosts.
    expect(desc).toMatch(/allow.?list|only.*napkin|refused|reject|napkin-hosted|not.*napkin/);
  });

  it('VAL-NAPKIN-009 — pre-existing happy-path download still works (regression)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-reg-'));
    createdDirs.push(tmpDir);

    mswServer.use(...createNapkinHandlers());

    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: tmpDir,
      },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: `https://api.napkin.ai/v1/visual/${mockRequestId}/file/output.svg`,
      filename: 'regression',
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as DownloadResult;
    expect(data.success).toBe(true);
    expect(data.file_path).toContain('regression.svg');
    expect((data.size_bytes ?? 0)).toBeGreaterThan(0);
    if (data.file_path) downloadedFiles.push(data.file_path);
  });
});
