import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mimeTypeForFileName, readSandboxedFile, sandboxedFileToBlob } from '../src/tools/file-input.js';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

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
  let base: string;

  afterEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockClear();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  function fixture() {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-file-input-')));
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    const source = path.join(workspace, 'clip.wav');
    const bytes = Buffer.from([0x00, 0x52, 0x49, 0x46, 0x46, 0x80, 0xff]);
    fs.writeFileSync(source, bytes);
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    vi.mocked(fs.existsSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    return { source, bytes };
  }

  it('refuses a final realpath escape after standalone admission before reading bytes', async () => {
    const { source } = fixture();
    const outside = path.join(base, 'outside.wav');
    fs.writeFileSync(outside, Buffer.from([0xff, 0x00, 0x81]));
    const actual = await vi.importActual<typeof import('fs')>('fs');

    // This existence check follows initial admission; only its timing is mocked.
    vi.mocked(fs.existsSync).mockImplementationOnce(candidate => {
      expect(candidate).toBe(source);
      expect(fs.realpathSync(candidate)).toBe(source);
      fs.unlinkSync(source);
      fs.symlinkSync(outside, source);
      return actual.existsSync(candidate);
    });

    expect(() => readSandboxedFile(source)).toThrowError(expect.objectContaining({
      code: 'PATH_SANDBOX_VIOLATION',
    }));
    expect(fs.existsSync).toHaveBeenCalledExactlyOnceWith(source);
    expect(fs.realpathSync(source)).toBe(outside);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('preserves exact binary bytes, filename and MIME for an ordinary standalone file', async () => {
    const { source, bytes } = fixture();
    const result = readSandboxedFile(source);

    expect(result).toStrictEqual({ buffer: bytes, fileName: 'clip.wav', verifiedPath: source });
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(source);
    const blob = sandboxedFileToBlob(result);
    expect(blob.type).toBe('audio/wav');
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  });
});
