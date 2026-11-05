import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import wireFixture from '../../../test-harness/test/fixtures/file-read/wire-v1.json';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { createServer } from '../src/server.js';

const provider = vi.hoisted(() => ({
  upload: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
}));
vi.mock('../src/browser-client.js', () => ({ execAgentBrowser: provider.upload }));
// Observe real opens without replacing staging, descriptor checks, or file bytes.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

interface AllowedRead {
  location: (string | number)[];
  rawPath: string;
  canonicalPath: string;
}

let base: string;
let workspace: string;
let ordinary: string;
let sources: { alias: string; canonical: string; bytes: Buffer }[];
let uploads: { paths: string[]; bytes: Buffer[] }[];
let clients: McpTestClient[] = [];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-browser-sdk-')));
  workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  ordinary = path.join(workspace, 'ordinary.txt');
  fs.writeFileSync(ordinary, 'Acme ordinary bytes');
  sources = ['first', 'second'].map((name, index) => {
    const canonical = path.join(base, `${name}.bin`);
    const bytes = Buffer.from([0, 255, index, 13, 10, 65]);
    fs.writeFileSync(canonical, bytes);
    const alias = path.join(workspace, `linked-${name}.bin`);
    fs.symlinkSync(canonical, alias);
    return { alias, canonical, bytes };
  });
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  uploads = [];
  provider.upload.mockImplementation(async args => {
    expect(args.slice(0, 2)).toEqual(['upload', '@e3']);
    const paths = args.slice(2);
    uploads.push({ paths, bytes: paths.map(file => fs.readFileSync(file)) });
    return { stdout: '', stderr: '' };
  });
});

afterEach(async () => {
  try {
    const results = await Promise.allSettled(clients.map(client => client.close()));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  } finally {
    clients = [];
    provider.upload.mockReset();
    vi.mocked(fs.openSync).mockClear();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

async function connect(negotiated = true) {
  const client = await createInMemoryTestClient({
    createServer,
    clientCapabilities: negotiated ? FILE_READ_CAPABILITIES : {},
  });
  clients.push(client);
  return client;
}

function central(reads: AllowedRead[]) {
  return { ...wireFixture.central, reads };
}

describe('browser_upload SDK file-read authority', () => {
  it('forwards concrete array metadata to canonical byte staging and the provider', async () => {
    const pair = await connect();
    expect(pair.client.getServerCapabilities()?.experimental?.['files/readModes']).toEqual(wireFixture.authority);
    const reads = sources.map(({ alias, canonical }, index) => ({
      location: ['file_paths', index], rawPath: alias, canonicalPath: canonical,
    }));
    vi.mocked(fs.openSync).mockClear();

    const result = await pair.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: sources.map(source => source.alias) },
      _meta: { 'files/readMode': central(reads.reverse()) },
    });

    expect(result.isError).not.toBe(true);
    expect(provider.upload).toHaveBeenCalledTimes(1);
    expect(uploads[0].bytes).toEqual(sources.map(source => source.bytes));
    expect(uploads[0].paths.map(file => path.basename(file))).toEqual(['first.bin', 'second.bin']);
    for (const [index, source] of sources.entries()) {
      expect(vi.mocked(fs.openSync).mock.calls.map(([file]) => file)).toContain(source.canonical);
      expect(vi.mocked(fs.openSync).mock.calls.map(([file]) => file)).not.toContain(source.alias);
      const staged = uploads[0].paths[index];
      expect(path.relative(workspace, staged).startsWith('browser-upload-')).toBe(true);
      expect(fs.existsSync(staged)).toBe(false);
    }
    expect(fs.readdirSync(workspace).sort()).toEqual(['linked-first.bin', 'linked-second.bin', 'ordinary.txt']);
  });

  it('opens nothing and never uploads when ordinary workspace bytes lack exact request authority', async () => {
    const pair = await connect();
    const allowed: AllowedRead = { location: ['file_paths', 0], rawPath: ordinary, canonicalPath: ordinary };
    const cases = [
      { label: 'omitted operand', mode: central([]) },
      { label: 'wrong array index', mode: central([{ ...allowed, location: ['file_paths', 1] }]) },
      { label: 'different raw spelling', mode: central([{ ...allowed, rawPath: `${workspace}${path.sep}.${path.sep}ordinary.txt` }]) },
      { label: 'denied outcome', mode: wireFixture.denied },
      { label: 'missing request mode', mode: undefined },
    ];
    for (const { label, mode } of cases) {
      vi.mocked(fs.openSync).mockClear();
      const result = await pair.client.callTool({
        name: 'browser_upload',
        arguments: {
          ref: '@e3', file_paths: [ordinary],
          _meta: { 'files/readMode': central([allowed]) },
        },
        ...(mode === undefined ? {} : { _meta: { 'files/readMode': mode } }),
      });
      expect(result.isError, label).toBe(true);
      expect(fs.openSync, label).not.toHaveBeenCalled();
      expect(provider.upload, label).not.toHaveBeenCalled();
      expect(fs.readdirSync(workspace).sort(), label).toEqual(['linked-first.bin', 'linked-second.bin', 'ordinary.txt']);
    }
  });

  it('retains ordinary standalone uploads and linked-source refusal with and without negotiation', async () => {
    for (const negotiated of [false, true]) {
      const pair = await connect(negotiated);
      const metadata = negotiated ? { _meta: { 'files/readMode': wireFixture.standalone } } : {};
      const ordinaryResult = await pair.client.callTool({
        name: 'browser_upload', arguments: { ref: '@e3', file_paths: [ordinary] }, ...metadata,
      });
      expect(ordinaryResult.isError).not.toBe(true);
      expect(uploads.at(-1)?.bytes).toEqual([Buffer.from('Acme ordinary bytes')]);
      const beforeRefusal = provider.upload.mock.calls.length;
      vi.mocked(fs.openSync).mockClear();
      const linkedResult = await pair.client.callTool({
        name: 'browser_upload', arguments: { ref: '@e3', file_paths: [sources[0].alias] }, ...metadata,
      });
      expect(linkedResult.isError).toBe(true);
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(provider.upload).toHaveBeenCalledTimes(beforeRefusal);
    }
    expect(provider.upload).toHaveBeenCalledTimes(2);
  });
});
