import { describe, it, expect } from 'vitest';
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
