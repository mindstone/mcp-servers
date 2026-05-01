/**
 * Path-sandbox tests for `transcribe_audio` (M3.9).
 *
 * Covers VAL-ELEVENLABS-001..003, VAL-ELEVENLABS-101..103, VAL-ELEVENLABS-201,
 * VAL-ELEVENLABS-301:
 *  - file_path under MCP_WORKSPACE_PATH (or os.tmpdir() when unset) succeeds.
 *  - paths outside the workspace root are rejected.
 *  - `..` traversal rejected before any disk read.
 *  - symlink-escape via realpathSync is caught.
 *  - remote https:// URLs continue to take the pre-existing not-found code
 *    path (no sandbox-violation error).
 *  - existing happy-path / error-path tests stay green (VAL-ELEVENLABS-301).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, makeFakeAudioBuffer } from './fixtures/elevenlabs-data.js';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Wire MSW with a counter so tests can assert "upstream was NOT called".
 */
function captureSttHandlers() {
  let calls = 0;
  const handlers = [
    http.post(STT_URL, () => {
      calls += 1;
      return HttpResponse.json({ text: 'hello', words: [] });
    }),
  ];
  return { handlers, getCalls: () => calls };
}

describe('transcribe_audio — path sandbox (M3.9)', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let outsideDir: string;
  const createdSymlinks: string[] = [];
  const createdFiles: string[] = [];

  beforeEach(() => {
    // Realpath the tmpdir so tests behave consistently on macOS where
    // /tmp -> /private/tmp and /var/folders is a symlinked path.
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-ws-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-outside-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
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

  it('VAL-ELEVENLABS-001 — in-workspace path succeeds', async () => {
    const { handlers, getCalls } = captureSttHandlers();
    mswServer.use(...handlers);

    const sourcePath = path.join(workspaceDir, 'clip.mp3');
    fs.writeFileSync(sourcePath, makeFakeAudioBuffer(512));

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: sourcePath,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('hello');
    expect(getCalls()).toBe(1);
  });

  it('VAL-ELEVENLABS-002 — when MCP_WORKSPACE_PATH is unset, falls back to os.tmpdir()', async () => {
    const { handlers, getCalls } = captureSttHandlers();
    mswServer.use(...handlers);

    // Place the file directly under os.tmpdir() (NOT under our `workspaceDir` mktemp dir)
    const tmpFile = path.join(
      fs.realpathSync(os.tmpdir()),
      `eleven-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
    );
    fs.writeFileSync(tmpFile, makeFakeAudioBuffer(512));
    createdFiles.push(tmpFile);

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        // Explicitly clear so the connector falls back to tmpdir
        MCP_WORKSPACE_PATH: '',
      },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: tmpFile,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(getCalls()).toBe(1);
  });

  it('VAL-ELEVENLABS-003 — https:// URL does NOT trigger a sandbox-violation error', async () => {
    const { handlers } = captureSttHandlers();
    mswServer.use(...handlers);

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: 'https://example.com/clip.mp3',
    });

    // The connector either forwards the URL upstream or returns a clear
    // non-sandbox error. What it must NOT do is emit a sandbox/workspace
    // violation message for a URL input.
    if (result.isError) {
      expect(result.text).not.toMatch(/sandbox/i);
      expect(result.text).not.toMatch(/workspace.*root/i);
    }
  });

  // ---------------------- REJECTED PATHS ----------------------

  it('VAL-ELEVENLABS-101 — absolute path outside MCP_WORKSPACE_PATH is rejected', async () => {
    const { handlers, getCalls } = captureSttHandlers();
    mswServer.use(...handlers);

    // File exists, but under a DIFFERENT mktemp dir (outside workspaceDir).
    const outsideFile = path.join(outsideDir, 'outside.mp3');
    fs.writeFileSync(outsideFile, makeFakeAudioBuffer(512));

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: outsideFile,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error || result.text).toMatch(/workspace|sandbox|outside|allow-list/i);
    expect(getCalls()).toBe(0);
  });

  it('VAL-ELEVENLABS-102 — parent-traversal `..` segments rejected', async () => {
    const { handlers, getCalls } = captureSttHandlers();
    mswServer.use(...handlers);

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const traversal = path.join(workspaceDir, '..', '..', 'etc', 'passwd');
    const result = await testClient.callTool('transcribe_audio', {
      file_path: traversal,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/sandbox|outside|workspace|traversal/i);
    expect(getCalls()).toBe(0);
  });

  it('VAL-ELEVENLABS-103 — symlink inside workspace pointing outside is rejected (realpathSync)', async () => {
    if (process.platform === 'win32') return; // symlinks unreliable on Windows w/o admin
    const { handlers, getCalls } = captureSttHandlers();
    mswServer.use(...handlers);

    const target = path.join(outsideDir, 'escape-target.mp3');
    fs.writeFileSync(target, makeFakeAudioBuffer(512));

    const symlinkPath = path.join(workspaceDir, 'escape.mp3');
    fs.symlinkSync(target, symlinkPath);
    createdSymlinks.push(symlinkPath);

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: symlinkPath,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/workspace|sandbox|outside|allow-list|symlink/i);
    expect(getCalls()).toBe(0);
  });

  // ---------------------- STATIC ASSERTION ----------------------

  it('VAL-ELEVENLABS-201 — realpathSync and MCP_WORKSPACE_PATH are referenced in src/tools/transcription.ts (static)', () => {
    const transcriptionTs = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'tools', 'transcription.ts'),
      'utf8',
    );
    const pathSafetyPath = path.resolve(__dirname, '..', 'src', 'tools', 'path-safety.ts');
    const pathSafetyTs = fs.existsSync(pathSafetyPath)
      ? fs.readFileSync(pathSafetyPath, 'utf8')
      : '';
    const combined = `${transcriptionTs}\n${pathSafetyTs}`;
    // VAL-ELEVENLABS-201: rg -n "realpathSync|MCP_WORKSPACE_PATH" connectors/elevenlabs/src/tools/transcription.ts
    expect(transcriptionTs).toMatch(/realpathSync|MCP_WORKSPACE_PATH/);
    // Defence-in-depth: BOTH terms appear somewhere in the security-relevant module set
    expect(combined).toMatch(/realpathSync/);
    expect(combined).toMatch(/MCP_WORKSPACE_PATH/);
  });

  // ---------------------- REGRESSION ----------------------

  it('VAL-ELEVENLABS-301 — pre-existing FILE_NOT_FOUND happy path is preserved for in-workspace missing files', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });

    const missing = path.join(workspaceDir, 'does-not-exist.mp3');
    const result = await testClient.callTool('transcribe_audio', {
      file_path: missing,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(false);
    // Either the new sandbox helper or the legacy existsSync branch raises
    // FILE_NOT_FOUND for an in-workspace missing path.
    expect(parsed.code).toBe('FILE_NOT_FOUND');
  });
});
