import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createNapkinHandlers } from './helpers/napkin-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, mockSvgContent, mockRequestId } from './fixtures/napkin-data.js';

const BASE = 'https://api.napkin.ai/v1';

describe('napkin_download_visual', () => {
  let testClient: McpTestClient;
  const downloadedFiles: string[] = [];
  const createdDirs: string[] = [];

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    // Clean up downloaded files
    for (const f of downloadedFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    downloadedFiles.length = 0;
    // Clean up created directories (in reverse order)
    for (const d of createdDirs.reverse()) {
      try {
        if (fs.existsSync(d)) fs.rmdirSync(d, { recursive: true } as fs.RmDirOptions);
      } catch { /* ignore */ }
    }
    createdDirs.length = 0;
  });

  it('downloads visual with auto-detected .svg extension', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-test-'));
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
      filename: 'test-visual',
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as { success: boolean; file_path: string; size_bytes: number };
    expect(data.success).toBe(true);
    expect(data.file_path).toContain('test-visual.svg');
    expect(data.size_bytes).toBeGreaterThan(0);
    expect(fs.existsSync(data.file_path)).toBe(true);
    downloadedFiles.push(data.file_path);
  });

  it('detects .png extension from URL', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-test-'));
    createdDirs.push(tmpDir);

    mswServer.use(
      http.get(`${BASE}/visual/*/file/*.png`, ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${MOCK_API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return new HttpResponse(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
          headers: { 'Content-Type': 'image/png' },
        });
      }),
    );

    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: tmpDir,
      },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: `https://api.napkin.ai/v1/visual/${mockRequestId}/file/output.png`,
      filename: 'test-png',
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as { file_path: string };
    expect(data.file_path).toContain('.png');
    if (fs.existsSync(data.file_path)) downloadedFiles.push(data.file_path);
  });

  it('detects .pptx extension from URL', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-test-'));
    createdDirs.push(tmpDir);

    mswServer.use(
      http.get(`${BASE}/visual/*/file/*.pptx`, ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${MOCK_API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return new HttpResponse(Buffer.from('mock-pptx'), {
          headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
        });
      }),
    );

    testClient = await createTestClient({
      env: {
        NAPKIN_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
        HOME: tmpDir,
      },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: `https://api.napkin.ai/v1/visual/${mockRequestId}/file/output.pptx`,
      filename: 'test-pptx',
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as { file_path: string };
    expect(data.file_path).toContain('.pptx');
    if (fs.existsSync(data.file_path)) downloadedFiles.push(data.file_path);
  });

  it('auto-generates filename when not provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napkin-test-'));
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
    });

    expect(result.isError).toBeFalsy();
    const data = result.json as { file_path: string };
    expect(data.file_path).toContain('napkin-');
    expect(data.file_path).toContain('.svg');
    if (fs.existsSync(data.file_path)) downloadedFiles.push(data.file_path);
  });

  it('requires API key', async () => {
    testClient = await createTestClient({
      env: { NAPKIN_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: 'https://api.napkin.ai/v1/visual/test/file/output.svg',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('API key not configured');
  });

  it('rejects empty file_url via Zod', async () => {
    testClient = await createTestClient({
      env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('napkin_download_visual', {
      file_url: '',
    });

    expect(result.isError).toBe(true);
  });
});

describe('Output directory resolution', () => {
  it('resolves to workspace path when MCP_WORKSPACE_PATH is set', async () => {
    // Import the module to test resolveOutputDir
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    vi.resetModules();
    const { resolveOutputDir } = await import('../src/tools/download.js');

    const dir = resolveOutputDir();
    expect(dir).toBe('/tmp/test-workspace/Chief-of-Staff/generated-visuals');

    vi.unstubAllEnvs();
  });

  it('resolves to ~/Pictures/NapkinVisuals when MCP_WORKSPACE_PATH is not set', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '');
    vi.stubEnv('HOME', '/Users/testuser');
    vi.resetModules();
    const { resolveOutputDir } = await import('../src/tools/download.js');

    const dir = resolveOutputDir();
    expect(dir).toBe('/Users/testuser/Pictures/NapkinVisuals');

    vi.unstubAllEnvs();
  });
});
