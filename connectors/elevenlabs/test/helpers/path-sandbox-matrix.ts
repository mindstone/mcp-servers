/**
 * Shared path-sandbox escape-matrix fixtures for file-input sinks.
 * Mirrors patterns from transcription-security.test.ts without modifying that file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { makeFakeAudioBuffer } from '../fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

export interface PathSandboxDirs {
  workspaceDir: string;
  outsideDir: string;
}

export function createPathSandboxDirs(): PathSandboxDirs {
  return {
    workspaceDir: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-ps-ws-'))),
    outsideDir: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-ps-out-'))),
  };
}

export function cleanupPathSandboxDirs(dirs: PathSandboxDirs): void {
  try { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dirs.outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Find a directory accessible via two paths: a symlinked alias and its
 * canonical (realpath'd) target. Returns null if no such pair exists.
 */
export function findSymlinkAlias(): { alias: string; canonical: string } | null {
  const candidates = ['/tmp'];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const real = fs.realpathSync(c);
      if (real !== c) {
        return { alias: c, canonical: real };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export type EscapeClass =
  | 'absolute-outside-root'
  | 'traversal'
  | 'tilde-expansion'
  | 'symlink-escape'
  | 'remote-url';

export interface EscapeCase {
  class: EscapeClass;
  label: string;
  buildPath: (ctx: PathSandboxDirs, symlinks: string[]) => string;
  skip?: () => boolean;
}

export function stage3EscapeCases(): EscapeCase[] {
  return [
    {
      class: 'absolute-outside-root',
      label: 'absolute path outside MCP_WORKSPACE_PATH',
      buildPath: (ctx) => {
        const outsideFile = path.join(ctx.outsideDir, 'outside.mp3');
        fs.writeFileSync(outsideFile, makeFakeAudioBuffer(512));
        return outsideFile;
      },
    },
    {
      class: 'traversal',
      label: 'parent-traversal `..` segments',
      buildPath: (ctx) => path.join(ctx.workspaceDir, '..', '..', 'etc', 'passwd'),
    },
    {
      class: 'tilde-expansion',
      label: 'tilde (`~`) expands outside workspace root',
      buildPath: () => path.join(os.homedir(), `eleven-tilde-escape-${process.pid}.mp3`),
    },
    {
      class: 'symlink-escape',
      label: 'symlink inside workspace pointing outside (realpathSync)',
      skip: () => process.platform === 'win32',
      buildPath: (ctx, symlinks) => {
        const target = path.join(ctx.outsideDir, 'escape-target.mp3');
        fs.writeFileSync(target, makeFakeAudioBuffer(512));
        const symlinkPath = path.join(ctx.workspaceDir, 'escape.mp3');
        fs.symlinkSync(target, symlinkPath);
        symlinks.push(symlinkPath);
        return symlinkPath;
      },
    },
    {
      class: 'remote-url',
      label: 'remote https:// URL fallthrough (non-sandbox)',
      buildPath: () => 'https://example.com/clip.mp3',
    },
  ];
}

/** MSW handler factory that counts upstream calls for a Stage 3 file-input endpoint. */
export function captureStage3Endpoint(endpointPattern: string) {
  let calls = 0;
  const handler = http.post(endpointPattern, () => {
    calls += 1;
    if (endpointPattern.includes('forced-alignment')) {
      return HttpResponse.json({ words: [{ text: 'Hi.', start: 0, end: 0.3 }], loss: 0 });
    }
    if (endpointPattern.includes('voices/add')) {
      return HttpResponse.json({ voice_id: 'cloned-voice-001', requires_verification: false });
    }
    return new HttpResponse(makeFakeAudioBuffer(512), {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  });
  return { handler, getCalls: () => calls };
}

export const STAGE3_ENDPOINTS = {
  speech_to_speech: `${BASE_V1}/speech-to-speech/:voiceId`,
  isolate_audio: `${BASE_V1}/audio-isolation`,
  forced_alignment: `${BASE_V1}/forced-alignment`,
  clone_voice: `${BASE_V1}/voices/add`,
} as const;

export interface ToolCallResult {
  isError: boolean;
  text: string;
}

export function expectSandboxRejection(result: ToolCallResult, getCalls: () => number): void {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(result.text);
  expect(parsed.ok).toBe(false);
  expect(parsed.code).toBe('PATH_SANDBOX_VIOLATION');
  expect(parsed.error || result.text).toMatch(/workspace|sandbox|outside|allow-list|traversal|symlink/i);
  expect(getCalls()).toBe(0);
}

export function expectRemoteUrlFallthrough(result: ToolCallResult, getCalls: () => number): void {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(result.text);
  expect(parsed.ok).toBe(false);
  expect(parsed.code).toBe('FILE_NOT_FOUND');
  expect(parsed.error).not.toMatch(/outside the workspace sandbox/i);
  expect(result.text).not.toMatch(/sandbox violation/i);
  expect(getCalls()).toBe(0);
}
