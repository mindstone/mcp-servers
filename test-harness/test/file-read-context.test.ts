import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FILE_READ_CAPABILITIES, centralReadPath, fileReadContext, readModeSchema } from '../src/file-read-context.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/file-read/wire-v1.json', import.meta.url), 'utf8'));

describe('file read wire v1', () => {
  it('accepts the shared wire modes and looks up only the exact concrete operand', () => {
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': fixture.central } });
    expect(readModeSchema.parse(fixture.standalone).mode).toBe('standalone');
    expect(centralReadPath(mode, 'report.txt', ['attachments', 0, 'path'])).toBe('/physical/report.txt');
    expect(() => centralReadPath(mode, 'report.txt', ['attachments', 1, 'path'])).toThrow(/concrete operand/);
    expect(() => centralReadPath(mode, './report.txt', ['attachments', 0, 'path'])).toThrow(/concrete operand/);
  });

  it('keeps an empty central batch central and refuses missing, malformed, pending and denied modes', () => {
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    expect(empty.mode).toBe('central');
    expect(() => centralReadPath(empty, '/workspace/file', ['file'])).toThrow(/concrete operand/);
    for (const mode of [undefined, {}, fixture.pending, fixture.denied, fixture.unavailable,
      { version: 1, mode: 'central', reads: [{ location: ['file'], rawPath: 'file', canonicalPath: 'relative' }] }]) {
      expect(() => fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': mode } })).toThrow(/request files\/readMode/);
    }
    expect(() => fileReadContext(FILE_READ_CAPABILITIES, { arguments: fixture.forgedArguments })).toThrow();
  });

  it('retains legacy standalone only when the connection did not negotiate version 1', () => {
    expect(fileReadContext(undefined, fixture.forgedArguments).mode).toBe('standalone');
    expect(fileReadContext({ experimental: { 'files/readModes': { version: 2 } } }, {}).mode).toBe('standalone');
    expect(fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': fixture.standalone } }).mode).toBe('standalone');
  });

  it('keeps every published vendored copy identical to the canonical helper', () => {
    const source = readFileSync(new URL('../src/file-read-context.ts', import.meta.url), 'utf8');
    for (const family of ['_template', 'browser-automation', 'browserbase', 'computers', 'elevenlabs',
      'elevenlabs-agents', 'email-imap', 'google-workspace', 'hubspot', 'kling', 'nano-banana',
      'openai-image', 'opus-video-clip', 'pandadoc', 'retell-ai', 'runway', 'slack']) {
      expect(readFileSync(new URL(`../../connectors/${family}/src/file-read-context.ts`, import.meta.url), 'utf8'), family).toBe(source);
    }
  });
});
