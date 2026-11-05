import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Computers } from '../src/computers.js';
import { createServer } from '../src/server.js';
import type { Provider } from '../src/provider.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

let base: string;
let workspace: string;
let canonical: string;
const bytes = Buffer.from([0, 255, 65, 13, 10, 128]);
const ordinaryBytes = Buffer.from('Acme ordinary Library bytes');
const computer = { provider: 'fly' as const, id: 'synthetic', name: 'acme', state: 'running' as const };
const upload = vi.fn(async () => undefined);
const provider: Provider = {
  id: 'fly', label: 'Example provider', user: 'root', home: '/root', execLimitSec: 30, idleShutdown: null,
  check: async () => 'ready', list: async () => [], create: async () => { throw new Error('unused'); },
  start: async () => undefined, stop: async () => undefined, remove: async () => undefined,
  exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), upload, download: async () => Buffer.alloc(0),
};
let ready: MockInstance<Computers['ready']>;
let clients: { close: () => Promise<void> }[] = [];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-library-')));
  workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  canonical = path.join(base, 'source.bin');
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(path.join(workspace, 'ordinary.txt'), ordinaryBytes);
  fs.symlinkSync(canonical, path.join(workspace, 'linked.txt'));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  ready = vi.spyOn(Computers.prototype, 'ready').mockResolvedValue({ provider, computer });
});

afterEach(async () => {
  try {
    await Promise.all(clients.map(client => client.close()));
  } finally {
    clients = [];
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

async function connect(negotiated = true) {
  const server = createServer({});
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: negotiated ? FILE_READ_CAPABILITIES : {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pair = {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  clients.push(pair);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return pair;
}

it('copies canonical Library-relative bytes to the provider and keeps inline-content precedence', async () => {
  const pair = await connect();
  const result = await pair.client.callTool({ name: 'computer_copy_in', arguments: { computer: 'acme', library_path: 'linked.txt', destination: 'copy.txt' }, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['library_path'], rawPath: 'linked.txt', canonicalPath: canonical }] } } });
  expect(result.isError).toBeFalsy();
  expect(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', bytes, 'new');
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(canonical);
  vi.clearAllMocks();
  const inline = await pair.client.callTool({ name: 'computer_copy_in', arguments: { computer: 'acme', content: '', destination: 'empty.txt' }, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  expect(inline.isError).toBeFalsy();
  expect(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/empty.txt', Buffer.alloc(0), 'new');
  expect(fsp.readFile).not.toHaveBeenCalled();
  expect(fsp.open).not.toHaveBeenCalled();
});

it('rejects missing, malformed and empty negotiated authority before preparation or source opens', async () => {
  const pair = await connect();
  const modes = [
    undefined,
    { version: 1, mode: 'central', reads: 'invalid' },
    { version: 1, mode: 'central', reads: [] },
    { version: 1, mode: 'central', reads: [{ location: ['other'], rawPath: 'ordinary.txt', canonicalPath: path.join(workspace, 'ordinary.txt') }] },
  ];
  vi.clearAllMocks();
  for (const mode of modes) {
    const result = await pair.client.callTool({
      name: 'computer_copy_in', arguments: { computer: 'acme', library_path: 'ordinary.txt', destination: 'copy.txt' },
      ...(mode === undefined ? {} : { _meta: { 'files/readMode': mode } }),
    });
    expect(result.isError).toBe(true);
    expect(ready).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(fsp.open).not.toHaveBeenCalled();
  }
});

it.each([false, true])('preserves ordinary, linked and empty-inline standalone behavior (negotiated=%s)', async negotiated => {
  const pair = await connect(negotiated);
  const metadata = negotiated ? { _meta: { 'files/readMode': { version: 1, mode: 'standalone' } } } : {};
  const ordinary = await pair.client.callTool({
    name: 'computer_copy_in', arguments: { computer: 'acme', library_path: 'ordinary.txt', destination: 'copy.txt' }, ...metadata,
  });
  expect(ordinary.isError).toBeFalsy();
  expect(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', ordinaryBytes, 'new');
  expect(fsp.readFile).toHaveBeenCalledWith(path.join(workspace, 'ordinary.txt'));
  vi.clearAllMocks();

  const linked = await pair.client.callTool({
    name: 'computer_copy_in', arguments: { computer: 'acme', library_path: 'linked.txt', destination: 'copy.txt' }, ...metadata,
  });
  expect(linked.isError).toBe(true);
  expect(JSON.stringify(linked.content)).toMatch(/OUTSIDE_LIBRARY/);
  expect(upload).not.toHaveBeenCalled();
  expect(fsp.readFile).not.toHaveBeenCalled();
  vi.clearAllMocks();

  const inline = await pair.client.callTool({
    name: 'computer_copy_in', arguments: { computer: 'acme', content: '', destination: 'empty.txt' }, ...metadata,
  });
  expect(inline.isError).toBeFalsy();
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/empty.txt', Buffer.alloc(0), 'new');
  expect(fsp.readFile).not.toHaveBeenCalled();
});

it('keeps empty inline content distinct from absent content when both inputs are supplied', async () => {
  const pair = await connect();
  const result = await pair.client.callTool({
    name: 'computer_copy_in', arguments: { computer: 'acme', library_path: 'ordinary.txt', content: '', destination: 'copy.txt' },
    _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/BAD_ARGUMENTS/);
  expect(upload).not.toHaveBeenCalled();
  expect(fsp.readFile).not.toHaveBeenCalled();
});

function physicalReadFixture() {
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(approved);
  fs.mkdirSync(outsideDir);
  const source = path.join(approved, 'source.bin');
  const outside = path.join(outsideDir, 'source.bin');
  const outsideBytes = Buffer.from('Acme outside bytes B');
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'guard-linked.bin');
  fs.symlinkSync(source, alias);
  const request = (rawPath = alias, canonicalPath = source) => ({
    name: 'computer_copy_in',
    arguments: { computer: 'acme', library_path: rawPath, destination: 'copy.txt' },
    _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['library_path'], rawPath, canonicalPath }] } },
  });
  return { approved, source, outsideDir, outside, outsideBytes, alias, request };
}

it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'] as const)('refuses central %s retarget during ready before copying bytes', async kind => {
  const { approved, source, outsideDir, outside, outsideBytes, request } = physicalReadFixture();
  const pair = await connect();
  const approvedRequest = request();
  const approvedControl = await pair.client.callTool(approvedRequest);
  expect(approvedControl.isError).toBeFalsy();
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', bytes, 'new');
  vi.clearAllMocks();
  const outsideControl = await pair.client.callTool(request(outside, outside));
  expect(outsideControl.isError).toBeFalsy();
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', outsideBytes, 'new');
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(outside);
  vi.clearAllMocks();

  ready.mockImplementationOnce(async () => {
    if (kind === 'leaf') {
      fs.unlinkSync(source);
      fs.symlinkSync(outside, source);
    } else {
      fs.renameSync(approved, path.join(base, 'approved-backup'));
      fs.symlinkSync(outsideDir, approved);
    }
    return { provider, computer };
  });
  const result = await pair.client.callTool(approvedRequest);
  const readBytes = await Promise.all(vi.mocked(fsp.readFile).mock.results.flatMap(read => read.type === 'return' ? [read.value] : []));
  const outsideByteRead = readBytes.some(data => Buffer.isBuffer(data) && data.equals(outsideBytes));
  const providerViolation = vi.mocked(provider.upload).mock.calls.some(([, , data]) => data.equals(outsideBytes));
  expect.soft(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect.soft(result.isError).toBe(true);
  expect.soft(JSON.stringify(result.content)).toMatch(/SOURCE_MISSING/);
  expect.soft(outsideByteRead).toBe(false);
  expect.soft(providerViolation).toBe(false);
  expect.soft(upload).not.toHaveBeenCalled();
  expect.soft(fsp.readFile).not.toHaveBeenCalled();
  expect.soft(fsp.open).not.toHaveBeenCalled();
  expect.soft(JSON.stringify(result)).not.toContain(outsideBytes.toString('base64'));
  expect(JSON.stringify(result)).not.toContain(outside);
});

it.skipIf(process.platform === 'win32')('copies approved A when the raw alias is retargeted during ready', async () => {
  const { source, outside, alias, request } = physicalReadFixture();
  const pair = await connect();
  const approvedRequest = request();
  ready.mockImplementationOnce(async () => {
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    return { provider, computer };
  });
  const result = await pair.client.callTool(approvedRequest);
  expect(result.isError).toBeFalsy();
  expect(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', bytes, 'new');
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(source);
  expect(fsp.readFile).not.toHaveBeenCalledWith(alias);
});

it.skipIf(process.platform === 'win32')('keeps SOURCE_MISSING when approved C is deleted during ready', async () => {
  const { source, outside, request } = physicalReadFixture();
  const pair = await connect();
  const approvedRequest = request();
  ready.mockImplementationOnce(async () => {
    fs.unlinkSync(source);
    return { provider, computer };
  });
  const result = await pair.client.callTool(approvedRequest);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/SOURCE_MISSING/);
  expect(ready).toHaveBeenCalledExactlyOnceWith('acme');
  expect(upload).not.toHaveBeenCalled();
  expect(fsp.readFile).not.toHaveBeenCalled();
  expect(fsp.open).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(outside);
});

it.skipIf(process.platform === 'win32').each(['approved', 'outside'] as const)('copies exact explicitly approved %s bytes outside the Library', async kind => {
  const { source, outside, outsideBytes, request } = physicalReadFixture();
  const target = kind === 'approved' ? source : outside;
  const expected = kind === 'approved' ? bytes : outsideBytes;
  const approvedRequest = request(target, target);
  const pair = await connect();
  const result = await pair.client.callTool(approvedRequest);
  expect(result.isError).toBeFalsy();
  expect(upload).toHaveBeenCalledExactlyOnceWith(computer, '/root/copy.txt', expected, 'new');
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(target);
});
