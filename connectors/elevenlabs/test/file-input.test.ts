import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { documentMimeTypeForFileName, mimeTypeForFileName, readSandboxedFile, sandboxedFileToBlob } from '../src/tools/file-input.js';
import { constants as bufferConstants } from 'node:buffer';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe('document MIME and descriptor checks', () => {
  let base: string;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });
  function fixture() {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'document-input-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', base);
    const source = path.join(base, 'guide.txt');
    fs.writeFileSync(source, Buffer.from([65, 99, 109, 101, 0, 128, 255]));
    return source;
  }

  it.each([
    ['guide.pdf', 'application/pdf'], ['guide.TXT', 'text/plain'], ['guide.md', 'text/markdown'],
    ['guide.markdown', 'text/markdown'], ['guide.html', 'text/html'], ['guide.htm', 'text/html'],
    ['guide.doc', 'application/msword'], ['guide.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['guide.epub', 'application/epub+zip'], ['guide.rtf', 'application/rtf'], ['guide.csv', 'text/csv'],
    ['guide.json', 'application/json'], ['guide.unknown', 'application/octet-stream'], ['guide', 'application/octet-stream'],
    ['guide.constructor', 'application/octet-stream'],
  ])('maps %s to document MIME %s', (name, mime) => {
    expect(documentMimeTypeForFileName(name)).toBe(mime);
  });

  it('keeps the legacy txt MIME fallback and reads exact document bytes through an opened descriptor', () => {
    const source = fixture();
    expect(mimeTypeForFileName('x.txt')).toBe('audio/mpeg');
    const result = readSandboxedFile(source, undefined, ['files', 0, 'file_path'], 'document');
    expect(result).toEqual({ buffer: Buffer.from([65, 99, 109, 101, 0, 128, 255]), fileName: 'guide.txt', verifiedPath: source });
    expect(vi.mocked(fs.readFileSync).mock.calls.at(-1)?.[0]).toBeTypeOf('number');
  });

  it('refuses an unreadable document with a file error', () => {
    const source = fixture();
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('private OS detail'), { code: 'EACCES' }); });
    expect(() => readSandboxedFile(source, undefined, ['files', 0, 'file_path'], 'document'))
      .toThrowError(expect.objectContaining({ code: 'FILE_UNREADABLE', message: 'The document cannot be opened for reading.' }));
  });

  it('rejects a document exceeding the supported runtime size before opening it', () => {
    const source = fixture();
    const stat = fs.statSync(source);
    vi.spyOn(fs, 'statSync').mockReturnValue({ ...stat, size: bufferConstants.MAX_LENGTH + 1, isFile: () => true });
    const open = vi.spyOn(fs, 'openSync');
    expect(() => readSandboxedFile(source, undefined, ['files', 0, 'file_path'], 'document'))
      .toThrowError(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an opened descriptor whose identity differs before reading and closes it', () => {
    const source = fixture();
    const stat = fs.statSync(source);
    vi.spyOn(fs, 'fstatSync').mockReturnValue({ ...stat, ino: stat.ino + 1, isFile: () => true });
    vi.mocked(fs.readFileSync).mockClear();
    const close = vi.spyOn(fs, 'closeSync');
    expect(() => readSandboxedFile(source, undefined, ['files', 0, 'file_path'], 'document'))
      .toThrowError(expect.objectContaining({ code: 'FILE_NOT_FOUND' }));
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
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
