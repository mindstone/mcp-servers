import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { mimeTypeForFileName } from '../src/tools/file-input.js';

describe('mimeTypeForFileName', () => {
  const cases: Array<{ fileName: string; expected: string }> = [
    { fileName: 'clip.mp3', expected: 'audio/mpeg' },
    { fileName: 'clip.wav', expected: 'audio/wav' },
    { fileName: 'clip.m4a', expected: 'audio/mp4' },
    { fileName: 'clip.mp4', expected: 'video/mp4' },
    { fileName: 'clip.mov', expected: 'video/quicktime' },
    { fileName: 'clip.unknown', expected: 'audio/mpeg' },
    { fileName: 'CLIP.MP3', expected: 'audio/mpeg' },
  ];

  it.each(cases)('maps $fileName → $expected', ({ fileName, expected }) => {
    expect(mimeTypeForFileName(fileName)).toBe(expected);
  });
});

describe('readSandboxedFile TOCTOU guard', () => {
  it('re-checks final realpath containment before readFileSync', () => {
    const source = fs.readFileSync(new URL('../src/tools/file-input.ts', import.meta.url), 'utf8');
    const finalRealpath = source.indexOf('const verifiedPath = isRemoteUrl(rawFilePath) ? filePath : fs.realpathSync(filePath);');
    const finalCheck = source.indexOf('isInsideAudioWorkspaceRoot(verifiedPath, root)');
    const read = source.indexOf('fs.readFileSync(verifiedPath)');
    expect(finalRealpath).toBeGreaterThanOrEqual(0);
    expect(finalCheck).toBeGreaterThan(finalRealpath);
    expect(finalCheck).toBeLessThan(read);
    expect(source).toContain("'PATH_SANDBOX_VIOLATION'");
  });
});
