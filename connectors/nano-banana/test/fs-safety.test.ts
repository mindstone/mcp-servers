/**
 * Filesystem sandbox hardening:
 *  - existing files are never silently overwritten ('wx' write, SAVE_EXISTS)
 *  - save destinations are canonically contained (symlinked-dir escape refused)
 *  - local source reads go through one validated file descriptor (no
 *    check-then-use race)
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, createMockGeminiResponse } from './fixtures/nano-banana-data.js';
import {
  getSourceWorkspaceRoot,
  readSandboxedWorkspaceFile,
  resolveSavePath,
  resolveSourcePath,
} from '../src/tools/path-safety.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

describe('resolveSavePath — canonical containment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a save path inside a symlinked directory that escapes the workspace', () => {
    if (process.platform === 'win32') return;
    const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-ws-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-out-')));
    try {
      // A symlinked DIRECTORY inside the workspace pointing outside it: a
      // lexical-only containment check would wave `escape/out.png` through.
      fs.symlinkSync(outsideDir, path.join(workspaceDir, 'escape'));
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);

      const result = resolveSavePath('escape/out.png', 'image/png');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/workspace root/i);
      }
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('readSandboxedWorkspaceFile — open-once descriptor read', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-read-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads a validated in-workspace file through the descriptor', () => {
    const filePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);

    const resolved = resolveSourcePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.equals(ONE_PIXEL_PNG)).toBe(true);
    }
  });

  it('refuses to read a directory (fstat must say regular file)', () => {
    const dirPath = path.join(workspaceDir, 'a-directory.png');
    fs.mkdirSync(dirPath);

    const resolved = resolveSourcePath(dirPath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not a file/i);
    }
  });

  it('fails closed when the validated path is swapped for an escape symlink before the read', () => {
    if (process.platform === 'win32') return;
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-read-out-')));
    try {
      const filePath = path.join(workspaceDir, 'swap.png');
      fs.writeFileSync(filePath, ONE_PIXEL_PNG);

      const resolved = resolveSourcePath(filePath);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      // Swap the validated leaf for a symlink pointing OUTSIDE the workspace
      // between validation and read — the post-open re-verification must
      // catch the escape instead of reading the out-of-sandbox target.
      const escapeTarget = path.join(outsideDir, 'secret.png');
      fs.writeFileSync(escapeTarget, Buffer.from('out-of-sandbox-bytes'));
      fs.unlinkSync(filePath);
      fs.symlinkSync(escapeTarget, filePath);

      const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/workspace|sandbox|replaced|changed/i);
      }
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('save_path overwrite refusal', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-wsafe-')));
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
        HttpResponse.json(createMockGeminiResponse()),
      ),
    );
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function makeClient() {
    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
  }

  it('generate: refuses to overwrite an existing file (SAVE_EXISTS), original untouched', async () => {
    await makeClient();
    const existing = path.join(workspaceDir, 'already-here.png');
    const originalBytes = Buffer.from('pre-existing user content');
    fs.writeFileSync(existing, originalBytes);

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
      save_path: 'already-here.png',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SAVE_EXISTS');
    expect(result.text).not.toContain('Image generated and saved to');
    // The pre-existing file must be byte-identical — never truncated.
    expect(fs.readFileSync(existing).equals(originalBytes)).toBe(true);
    // The generated image is still returned inline so the result is not lost.
    expect(result.content.find((c: { type: string }) => c.type === 'image')).toBeDefined();
  });

  it('edit: refuses to overwrite an existing file (SAVE_EXISTS), original untouched', async () => {
    await makeClient();
    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);
    const existing = path.join(workspaceDir, 'edited.png');
    const originalBytes = Buffer.from('pre-existing user content');
    fs.writeFileSync(existing, originalBytes);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath,
      prompt: 'rotate',
      save_path: 'edited.png',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SAVE_EXISTS');
    expect(fs.readFileSync(existing).equals(originalBytes)).toBe(true);
  });
});
