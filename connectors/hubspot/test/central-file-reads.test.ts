import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';

const upload = vi.hoisted(() => vi.fn(async (_bytes: Buffer, _name: string, _options: unknown) => ({ id: 'file_synthetic', name: 'Acme file' })));
const provider = vi.hoisted(() => ({
  connect: vi.fn(),
  createObject: vi.fn(async () => ({ id: 'note_synthetic' })),
  createAssociation: vi.fn(async () => undefined),
  importFileFromUrlAndWait: vi.fn(),
}));
vi.mock('../src/api/hubspot-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api/hubspot-client.js')>(),
  getHubSpotClientAsync: async () => {
    provider.connect();
    return { uploadFile: upload, ...provider };
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});
let connection: { client: Client; server: Server } | undefined;
let base: string;
afterEach(async () => {
  try {
    try { await connection?.client.close(); }
    finally { await connection?.server.close(); }
  } finally {
    connection = undefined;
    vi.clearAllMocks();
    provider.connect.mockReset();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

it('sends exact canonical bytes to the provider and refuses standalone or missing authority', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-crm-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.txt');
  const bytes = Buffer.from('Acme document');
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  const { handleUploadFile } = await import('../src/tools/file-handlers.js');
  const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['filePath'], rawPath: alias, canonicalPath: canonical }] } } });
  await handleUploadFile({ filePath: alias }, mode);
  expect(upload).toHaveBeenCalledWith(bytes, 'source.txt', expect.any(Object));
  await expect(handleUploadFile({ filePath: alias })).rejects.toThrow(/PATH_OUTSIDE_WORKSPACE/);
  const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  await expect(handleUploadFile({ filePath: alias }, empty)).rejects.toThrow(/concrete operand/);
  expect(upload).toHaveBeenCalledTimes(1);
});

it.each(['upload', 'attach'] as const)('%s consumes canonical bytes without an unrelated workspace prerequisite', async handler => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-crm-admission-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'canonical.bin');
  const bytes = Buffer.from([0, 255, 65, 13, 10, 128]);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'linked.bin');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', path.join(base, 'unavailable-workspace'));
  const { handleUploadFile, handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');
  const invoke = (context?: ReturnType<typeof fileReadContext>, filePath = alias) => handler === 'upload'
    ? handleUploadFile({ filePath }, context)
    : handleAttachFileToRecord({ filePath, associations: { contactIds: ['123'] } }, context);
  const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location: ['filePath'], rawPath: alias, canonicalPath: canonical }],
  } } });
  await invoke(mode);
  expect(upload).toHaveBeenCalledExactlyOnceWith(bytes, 'canonical.bin', handler === 'attach'
    ? { folderPath: '/attachments', access: 'PRIVATE' }
    : { folderPath: undefined, access: undefined });
  expect(fsp.readFile).toHaveBeenCalledWith(canonical);
  expect(fsp.readFile).not.toHaveBeenCalledWith(alias);
  if (handler === 'attach') {
    expect(provider.createObject).toHaveBeenCalledWith('notes', expect.objectContaining({ hs_attachment_ids: 'file_synthetic' }));
    expect(provider.createAssociation).toHaveBeenCalledWith('notes', 'note_synthetic', 'contacts', '123', 'note_to_contact');
  }

  vi.clearAllMocks();
  await expect(invoke()).rejects.toThrow(/WORKSPACE_PATH_INVALID/);
  expect(fsp.readFile).not.toHaveBeenCalled();
  expect(provider.connect).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();

  const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  await expect(invoke(empty)).rejects.toThrow(/concrete operand/);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  const ordinary = path.join(workspace, 'ordinary.txt');
  fs.writeFileSync(ordinary, 'Acme ordinary bytes');
  await expect(invoke(empty, ordinary)).rejects.toThrow(/concrete operand/);
  expect(fsp.readFile).not.toHaveBeenCalled();
  expect(fsp.open).not.toHaveBeenCalled();
  expect(provider.connect).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(provider.createObject).not.toHaveBeenCalled();
  expect(provider.createAssociation).not.toHaveBeenCalled();
});

it('rejects missing and malformed negotiated modes through the real SDK before either reader or provider', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-crm-mode-')));
  const ordinary = path.join(base, 'ordinary.txt');
  fs.writeFileSync(ordinary, 'Acme ordinary bytes');
  vi.stubEnv('MCP_WORKSPACE_PATH', base);
  const { HubSpotServer } = await import('../src/tools/server.js');
  const server = (new HubSpotServer() as unknown as { server: Server }).server;
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: FILE_READ_CAPABILITIES });
  connection = { client, server };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  vi.clearAllMocks();
  for (const name of ['upload_hubspot_file', 'attach_file_to_record']) {
    for (const mode of [undefined, { version: 1, mode: 'central', reads: 'invalid' }]) {
      const result = await client.callTool({
        name, arguments: { filePath: ordinary, associations: { contactIds: ['123'] } },
        ...(mode === undefined ? {} : { _meta: { 'files/readMode': mode } }),
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/valid request files\/readMode/);
      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.open).not.toHaveBeenCalled();
      expect(provider.connect).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(provider.createObject).not.toHaveBeenCalled();
      expect(provider.createAssociation).not.toHaveBeenCalled();
    }
  }
});

it('keeps the remote attachment workspace prerequisite', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-crm-url-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', path.join(base, 'unavailable-workspace'));
  const { handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');
  const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  await expect(handleAttachFileToRecord({ fileUrl: 'https://example.com/file.txt', associations: { contactIds: ['123'] } }, empty)).rejects.toThrow(/WORKSPACE_PATH_INVALID/);
  expect(provider.connect).not.toHaveBeenCalled();
  expect(provider.importFileFromUrlAndWait).not.toHaveBeenCalled();
});

async function physicalReadFixture(handler: 'upload' | 'attach') {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-crm-physical-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const directory of [workspace, approved, outsideDir]) fs.mkdirSync(directory);
  const canonical = path.join(approved, 'source.txt');
  const outside = path.join(outsideDir, 'source.txt');
  const bytes = Buffer.from('Acme approved document A');
  const outsideBytes = Buffer.from('Acme outside document B');
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  const { handleUploadFile, handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');
  const context = (rawPath = alias, canonicalPath = canonical) => fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location: ['filePath'], rawPath, canonicalPath }],
  } } });
  const invoke = (mode: ReturnType<typeof fileReadContext>, filePath = alias) => handler === 'upload'
    ? handleUploadFile({ filePath }, mode)
    : handleAttachFileToRecord({ filePath, associations: { contactIds: ['123'] } }, mode);
  return { approved, canonical, outsideDir, outside, bytes, outsideBytes, alias, context, invoke };
}

it.skipIf(process.platform === 'win32').each([
  ['upload', 'leaf'], ['upload', 'ancestor'], ['attach', 'leaf'], ['attach', 'ancestor'],
] as const)('refuses central %s %s retarget at its original physical-check locus', async (handler, kind) => {
  const { approved, canonical, outsideDir, outside, bytes, outsideBytes, context, invoke } = await physicalReadFixture(handler);
  const mode = context();
  await invoke(mode);
  expect(upload).toHaveBeenCalledExactlyOnceWith(bytes, 'source.txt', expect.any(Object));
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(canonical);
  vi.clearAllMocks();
  await invoke(context(outside, outside), outside);
  expect(upload).toHaveBeenCalledExactlyOnceWith(outsideBytes, 'source.txt', expect.any(Object));
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(outside);
  vi.clearAllMocks();

  const swap = () => {
    if (kind === 'leaf') {
      fs.unlinkSync(canonical);
      fs.symlinkSync(outside, canonical);
    } else {
      fs.renameSync(approved, path.join(base, 'approved-backup'));
      fs.symlinkSync(outsideDir, approved);
    }
  };
  if (handler === 'attach') provider.connect.mockImplementationOnce(swap);
  else swap();
  let result: Awaited<ReturnType<typeof invoke>> | undefined;
  let error: unknown;
  try { result = await invoke(mode); } catch (caught) { error = caught; }
  const readBytes = await Promise.all(vi.mocked(fsp.readFile).mock.results.flatMap(read => read.type === 'return' ? [read.value] : []));
  const outsideByteRead = readBytes.some(data => Buffer.isBuffer(data) && data.equals(outsideBytes));
  const providerViolation = upload.mock.calls.some(([data]) => data.equals(outsideBytes));
  expect.soft(String(error)).toMatch(/FILE_NOT_FOUND/);
  expect.soft(result).toBeUndefined();
  expect.soft(outsideByteRead).toBe(false);
  expect.soft(providerViolation).toBe(false);
  expect.soft(upload).not.toHaveBeenCalled();
  expect.soft(provider.createObject).not.toHaveBeenCalled();
  expect.soft(provider.createAssociation).not.toHaveBeenCalled();
  expect.soft(fsp.readFile).not.toHaveBeenCalled();
  expect.soft(fsp.open).not.toHaveBeenCalled();
  expect.soft(provider.connect).toHaveBeenCalledTimes(handler === 'attach' ? 1 : 0);
  expect(`${String(error)} ${JSON.stringify(result)}`).not.toContain(outside);
});

it.skipIf(process.platform === 'win32').each(['upload', 'attach'] as const)('%s reads approved A after the raw alias is retargeted', async handler => {
  const { canonical, outside, bytes, alias, context, invoke } = await physicalReadFixture(handler);
  const mode = context();
  const swap = () => {
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
  };
  if (handler === 'attach') provider.connect.mockImplementationOnce(swap);
  else swap();
  await invoke(mode);
  expect(upload).toHaveBeenCalledExactlyOnceWith(bytes, 'source.txt', expect.any(Object));
  expect(fsp.readFile).toHaveBeenCalledExactlyOnceWith(canonical);
  expect(fsp.readFile).not.toHaveBeenCalledWith(alias);
  expect(provider.connect).toHaveBeenCalledTimes(1);
  expect(provider.createObject).toHaveBeenCalledTimes(handler === 'attach' ? 1 : 0);
  expect(provider.createAssociation).toHaveBeenCalledTimes(handler === 'attach' ? 1 : 0);
});

it.skipIf(process.platform === 'win32').each(['upload', 'attach'] as const)('%s keeps FILE_NOT_FOUND when approved C is deleted', async handler => {
  const { canonical, outside, context, invoke } = await physicalReadFixture(handler);
  const mode = context();
  const remove = () => { fs.unlinkSync(canonical); };
  if (handler === 'attach') provider.connect.mockImplementationOnce(remove);
  else remove();
  let error: unknown;
  try { await invoke(mode); } catch (caught) { error = caught; }
  expect(String(error)).toMatch(/FILE_NOT_FOUND/);
  expect(upload).not.toHaveBeenCalled();
  expect(provider.createObject).not.toHaveBeenCalled();
  expect(provider.createAssociation).not.toHaveBeenCalled();
  expect(fsp.readFile).not.toHaveBeenCalled();
  expect(fsp.open).not.toHaveBeenCalled();
  expect(provider.connect).toHaveBeenCalledTimes(handler === 'attach' ? 1 : 0);
  expect(String(error)).not.toContain(outside);
});
