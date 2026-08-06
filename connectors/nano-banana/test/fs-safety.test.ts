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
  writeContainedFileExclusive,
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

    const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot(), 1024);
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

    const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot(), 1024);
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

      const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot(), 1024);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/workspace|sandbox|replaced|changed/i);
      }
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('refuses an oversized file from its fstat size, before reading any bytes', () => {
    const filePath = path.join(workspaceDir, 'big.png');
    fs.writeFileSync(filePath, Buffer.alloc(1025, 0x41));

    const resolved = resolveSourcePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = readSandboxedWorkspaceFile(resolved.path, getSourceWorkspaceRoot(), 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_IMAGE_TOO_LARGE');
      expect(result.error).toMatch(/size limit/i);
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

describe('writeContainedFileExclusive — swap-proof contained write', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-write-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a validated path, creating missing directories, and cleans up staging', () => {
    const resolved = resolveSavePath('new-dir/sub/out.png', 'image/png');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = writeContainedFileExclusive(resolved.path, ONE_PIXEL_PNG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fs.readFileSync(result.path).equals(ONE_PIXEL_PNG)).toBe(true);
    if (process.platform !== 'win32') {
      // Written owner-only (0600) via the staging file.
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    }
    // No staging directory is left behind on the happy path.
    const leftovers = fs.readdirSync(path.dirname(result.path)).filter((e) => e.startsWith('.nano-banana-staging-'));
    expect(leftovers).toHaveLength(0);
  });

  it('fails closed when a directory component is swapped for an escape symlink after validation', () => {
    if (process.platform === 'win32') return;
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-write-out-')));
    try {
      // Validate while `sub` is a real in-workspace directory…
      const subDir = path.join(workspaceDir, 'sub');
      fs.mkdirSync(subDir);
      const resolved = resolveSavePath('sub/out.png', 'image/png');
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      // …then swap it for a symlink pointing OUTSIDE the workspace, as a
      // local attacker racing the write would. The write-time
      // re-canonicalisation must refuse instead of following the symlink.
      fs.rmdirSync(subDir);
      fs.symlinkSync(outsideDir, subDir);

      const result = writeContainedFileExclusive(resolved.path, ONE_PIXEL_PNG);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('rejected');
        expect(result.error).toMatch(/workspace|sandbox/i);
      }
      // Nothing was written outside the workspace.
      expect(fs.readdirSync(outsideDir)).toHaveLength(0);
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('refuses a destination symlink planted after validation (never followed, never overwritten)', () => {
    if (process.platform === 'win32') return;
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-write-link-')));
    try {
      const resolved = resolveSavePath('taken.png', 'image/png');
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      // Plant a symlink at the destination BETWEEN validation and write.
      const outsideTarget = path.join(outsideDir, 'victim.png');
      fs.writeFileSync(outsideTarget, Buffer.from('pre-existing user content'));
      fs.symlinkSync(outsideTarget, resolved.path);

      const result = writeContainedFileExclusive(resolved.path, ONE_PIXEL_PNG);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('exists');
      }
      // The symlink's target is byte-identical — the write never followed it.
      expect(fs.readFileSync(outsideTarget).equals(Buffer.from('pre-existing user content'))).toBe(true);
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('refuses to overwrite an existing file (exists), leaving it untouched', () => {
    const resolved = resolveSavePath('already.png', 'image/png');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const original = Buffer.from('pre-existing user content');
    fs.writeFileSync(resolved.path, original);

    const result = writeContainedFileExclusive(resolved.path, ONE_PIXEL_PNG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('exists');
    }
    expect(fs.readFileSync(resolved.path).equals(original)).toBe(true);
  });
});
