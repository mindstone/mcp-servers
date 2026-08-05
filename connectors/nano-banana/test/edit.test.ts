/**
 * Source-image sandbox tests for `nano_banana_edit` (M3.6).
 *
 * Covers VAL-NANO-001..104 and VAL-NANO-201..301:
 *  - source_image_path under MCP_WORKSPACE_PATH (or os.tmpdir() when unset) succeeds.
 *  - paths outside the workspace root are rejected.
 *  - symlink-escape via realpathSync is caught.
 *  - https:// URLs continue to work (no sandbox-violation error code).
 *  - existing happy-path / error-path tests stay green.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, createMockGeminiResponse } from './fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Canonical 1×1 transparent PNG (decoded from base64).
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

/** Wire MSW with a counter so tests can assert "geminiFetch was NOT called". */
function captureGeminiHandlers() {
  let upstreamCalls = 0;
  const handlers = [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () => {
      upstreamCalls += 1;
      return HttpResponse.json(createMockGeminiResponse());
    }),
  ];
  return { handlers, getCalls: () => upstreamCalls };
}

describe('nano_banana_edit — source-image sandbox (M3.6)', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let outsideDir: string;
  const createdSymlinks: string[] = [];
  const createdFiles: string[] = [];

  beforeEach(() => {
    // Realpath the tmpdir so tests behave consistently on macOS where
    // /tmp -> /private/tmp and /var/folders is a symlinked path.
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-ws-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-outside-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    // Clean up symlinks first so rm doesn't follow them
    for (const link of createdSymlinks) {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
    }
    createdSymlinks.length = 0;
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------- POSITIVE PATHS ----------------------

  it('VAL-NANO-001 — source path inside MCP_WORKSPACE_PATH succeeds', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath,
      prompt: 'rotate',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content.find((c: { type: string }) => c.type === 'image')).toBeDefined();
    expect(getCalls()).toBe(1);
  });

  it('VAL-NANO-002 — when MCP_WORKSPACE_PATH is unset, falls back to os.tmpdir()', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    // Place the file directly under os.tmpdir() (NOT under our `workspaceDir` mktemp dir)
    const tmpFile = path.join(
      fs.realpathSync(os.tmpdir()),
      `nano-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    fs.writeFileSync(tmpFile, ONE_PIXEL_PNG);
    createdFiles.push(tmpFile);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        // Explicitly clear so the connector falls back to tmpdir
        MCP_WORKSPACE_PATH: '',
      },
    });

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: tmpFile,
      prompt: 'rotate',
    });

    expect(result.isError).toBeFalsy();
    expect(getCalls()).toBe(1);
  });

  it('VAL-NANO-003 — https:// URL is fetched (no sandbox-violation error)', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(
      ...handlers,
      http.get('https://example.com/foo.png', () =>
        new HttpResponse(ONE_PIXEL_PNG, {
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(ONE_PIXEL_PNG.length) },
        }),
      ),
    );

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://example.com/foo.png',
      prompt: 'rotate',
    });

    // The URL is fetched and forwarded to the Gemini API — the local-file
    // sandbox must not fire on a remote URL.
    expect(result.isError).toBeFalsy();
    expect(getCalls()).toBe(1);
  });

  // ---------------------- REJECTED PATHS ----------------------

  it('VAL-NANO-101 — absolute path outside MCP_WORKSPACE_PATH is rejected', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    // File exists, but under a DIFFERENT mktemp dir (outside workspaceDir).
    const outsideFile = path.join(outsideDir, 'outside.png');
    fs.writeFileSync(outsideFile, ONE_PIXEL_PNG);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: outsideFile,
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/workspace|sandbox|outside|allow-list/i);
    expect(getCalls()).toBe(0);
  });

  it('VAL-NANO-102 — parent-traversal `..` segments rejected', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const traversal = path.join(workspaceDir, '..', '..', 'etc', 'passwd');
    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: traversal,
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/sandbox|outside|workspace|traversal/i);
    expect(getCalls()).toBe(0);
  });

  it('VAL-NANO-103 — symlink inside workspace pointing outside is rejected (realpathSync)', async () => {
    if (process.platform === 'win32') return; // symlinks unreliable on Windows w/o admin
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    const target = path.join(outsideDir, 'escape-target.png');
    fs.writeFileSync(target, ONE_PIXEL_PNG);

    const symlinkPath = path.join(workspaceDir, 'link.png');
    fs.symlinkSync(target, symlinkPath);
    createdSymlinks.push(symlinkPath);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: symlinkPath,
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/workspace|sandbox|outside|allow-list|symlink/i);
    expect(getCalls()).toBe(0);
  });

  it('VAL-NANO-104 — tilde-prefixed path under $HOME (outside workspace) rejected', async () => {
    const { handlers, getCalls } = captureGeminiHandlers();
    mswServer.use(...handlers);

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    // ~/Documents/secret.png — doesn't need to exist; the sandbox check
    // happens lexically before any fs read.
    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: '~/Documents/secret.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/workspace|sandbox|outside|allow-list|tilde/i);
    expect(getCalls()).toBe(0);
  });

  // ---------------------- STATIC ASSERTIONS ----------------------

  it('VAL-NANO-201 — local reads go through the open-once descriptor helper (static)', () => {
    const editTs = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'edit.ts'),
      'utf8',
    );
    const pathSafetyTs = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'path-safety.ts'),
      'utf8',
    );
    // The check-then-use race is closed by readSandboxedWorkspaceFile
    // (open once → fstat → inode re-verify → read through the descriptor).
    expect(editTs).toMatch(/readSandboxedWorkspaceFile/);
    expect(pathSafetyTs).toMatch(/fstatSync/);
  });

  it('VAL-NANO-202 — MCP_WORKSPACE_PATH is referenced in edit.ts or path-safety.ts (static)', () => {
    const editTs = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'edit.ts'),
      'utf8',
    );
    const pathSafetyTs = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'path-safety.ts'),
      'utf8',
    );
    expect(`${editTs}\n${pathSafetyTs}`).toMatch(/MCP_WORKSPACE_PATH/);
  });

  // ---------------------- REGRESSION ----------------------

  it('VAL-NANO-301 — existing AUTH_REQUIRED happy path is preserved', async () => {
    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath,
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });
});
