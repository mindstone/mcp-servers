/**
 * Workspace-output fence for generated/downloaded artifacts (AGENTS.md
 * invariant #5 applied to write targets) and exclusive-creation guarantees.
 *
 * Covers:
 *  - tool outputs land under the canonical MCP_WORKSPACE_PATH when set
 *  - pre-existing destination (file or symlink) is rejected, never overwritten
 *  - multi-artifact writes clean up earlier artifacts when a later one fails
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';
import {
  resolveWorkspaceOutputPath,
  writeWorkspaceArtifact,
  writeWorkspaceArtifacts,
} from '../src/tools/path-safety.js';

function listArtifactFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith('elevenlabs_'));
}

describe('workspace-output fence', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-out-ws-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('tool outputs land under canonical MCP_WORKSPACE_PATH', () => {
    it('generate_speech writes into the workspace, not the host tmpdir', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: {
          ELEVENLABS_API_KEY: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          MCP_WORKSPACE_PATH: workspaceDir,
        },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello world.',
        voice_id: 'voice-rachel-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path.startsWith(workspaceDir + path.sep)).toBe(true);
      expect(fs.existsSync(parsed.file_path)).toBe(true);
    });

    it('get_history_item_audio writes into the workspace, not the host tmpdir', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: {
          ELEVENLABS_API_KEY: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          MCP_WORKSPACE_PATH: workspaceDir,
        },
      });

      const result = await testClient.callTool('get_history_item_audio', {
        history_item_id: 'hist-item-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path.startsWith(workspaceDir + path.sep)).toBe(true);
      expect(fs.existsSync(parsed.file_path)).toBe(true);
    });

    it('generate_speech_with_timestamps writes audio, alignment, and SRT into the workspace', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: {
          ELEVENLABS_API_KEY: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          MCP_WORKSPACE_PATH: workspaceDir,
        },
      });

      const result = await testClient.callTool('generate_speech_with_timestamps', {
        text: 'Welcome home.',
        voice_id: 'voice-rachel-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      for (const key of ['file_path', 'srt_path', 'alignment_path'] as const) {
        expect(parsed[key], key).toBeTruthy();
        expect(parsed[key].startsWith(workspaceDir + path.sep), key).toBe(true);
        expect(fs.existsSync(parsed[key]), key).toBe(true);
      }
    });
  });

  describe('writeWorkspaceArtifact', () => {
    it('writes inside the canonical workspace root', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const dest = writeWorkspaceArtifact('elevenlabs_unit-test.mp3', 'data');
      expect(dest).toBe(path.join(workspaceDir, 'elevenlabs_unit-test.mp3'));
      expect(fs.readFileSync(dest, 'utf8')).toBe('data');
    });

    it('rejects a pre-existing file instead of overwriting it', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const existing = path.join(workspaceDir, 'elevenlabs_collision.mp3');
      fs.writeFileSync(existing, 'original');
      expect(() => writeWorkspaceArtifact('elevenlabs_collision.mp3', 'replacement')).toThrowError(
        /Refusing to overwrite/,
      );
      expect(fs.readFileSync(existing, 'utf8')).toBe('original');
    });

    it('rejects a pre-existing symlink destination without following it', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-out-target-')));
      try {
        // Symlink escaping the workspace: rejected by canonical containment
        // before any write is attempted.
        const target = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(target, 'untouched');
        fs.symlinkSync(target, path.join(workspaceDir, 'elevenlabs_link.mp3'));
        expect(() => writeWorkspaceArtifact('elevenlabs_link.mp3', 'payload')).toThrowError(
          /outside the workspace sandbox root/,
        );
        expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
        expect(fs.lstatSync(path.join(workspaceDir, 'elevenlabs_link.mp3')).isSymbolicLink()).toBe(true);

        // Symlink staying inside the workspace: passes containment, then the
        // exclusive create (O_EXCL does not follow symlinks) refuses it.
        const innerTarget = path.join(workspaceDir, 'elevenlabs_inner.txt');
        fs.writeFileSync(innerTarget, 'inner');
        fs.symlinkSync(innerTarget, path.join(workspaceDir, 'elevenlabs_inner-link.mp3'));
        expect(() => writeWorkspaceArtifact('elevenlabs_inner-link.mp3', 'payload')).toThrowError(
          /Refusing to overwrite/,
        );
        expect(fs.readFileSync(innerTarget, 'utf8')).toBe('inner');
        expect(fs.lstatSync(path.join(workspaceDir, 'elevenlabs_inner-link.mp3')).isSymbolicLink()).toBe(true);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('fails closed when the destination would escape the workspace root', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      expect(() => resolveWorkspaceOutputPath('../escape.mp3')).toThrowError(/workspace sandbox root/);
    });
  });

  describe('writeWorkspaceArtifacts', () => {
    it('removes earlier artifacts when a later write fails', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      // Pre-place the second artifact so the exclusive create fails mid-set.
      fs.writeFileSync(path.join(workspaceDir, 'elevenlabs_set.alignment.json'), 'occupied');
      expect(() =>
        writeWorkspaceArtifacts([
          { fileName: 'elevenlabs_set.mp3', data: 'audio' },
          { fileName: 'elevenlabs_set.alignment.json', data: '{}' },
          { fileName: 'elevenlabs_set.srt', data: 'srt' },
        ]),
      ).toThrowError(/Refusing to overwrite/);
      // The audio artifact written first must have been cleaned up.
      expect(fs.existsSync(path.join(workspaceDir, 'elevenlabs_set.mp3'))).toBe(false);
      expect(fs.existsSync(path.join(workspaceDir, 'elevenlabs_set.srt'))).toBe(false);
      // The pre-existing file is untouched.
      expect(fs.readFileSync(path.join(workspaceDir, 'elevenlabs_set.alignment.json'), 'utf8')).toBe('occupied');
    });

    it('returns all artifact paths on success', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const paths = writeWorkspaceArtifacts([
        { fileName: 'elevenlabs_ok.mp3', data: 'audio' },
        { fileName: 'elevenlabs_ok.srt', data: 'srt' },
      ]);
      expect(paths).toHaveLength(2);
      for (const p of paths) {
        expect(p.startsWith(workspaceDir + path.sep)).toBe(true);
        expect(fs.existsSync(p)).toBe(true);
      }
    });
  });

  describe('tool-level partial artifacts', () => {
    it('a with-timestamps response without audio fails before any artifact is written', async () => {
      mswServer.use(
        http.post('https://api.elevenlabs.io/v1/text-to-speech/:voiceId/with-timestamps', () =>
          HttpResponse.json({ normalized_alignment: null }),
        ),
      );
      testClient = await createTestClient({
        env: {
          ELEVENLABS_API_KEY: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          MCP_WORKSPACE_PATH: workspaceDir,
        },
      });

      const result = await testClient.callTool('generate_speech_with_timestamps', {
        text: 'Welcome home.',
        voice_id: 'voice-rachel-001',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).code).toBe('INVALID_RESPONSE');
      expect(listArtifactFiles(workspaceDir)).toHaveLength(0);
    });
  });
});
