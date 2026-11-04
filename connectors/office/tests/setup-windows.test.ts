import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWindowsAddin, unregisterWindowsAddin } from '../src/sidecar/manifest.js';

vi.mock('../src/sidecar/manifest.js', () => ({
  registerWindowsAddin: vi.fn(),
  unregisterWindowsAddin: vi.fn(),
}));

type ServerTestApi = {
  server: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> };
  setSpawnSidecarAndWaitForTests: (fn: () => Promise<void>) => void;
  resetForTests: () => void;
};

let stateDir: string;
let stateFile: string;
let client: Client | undefined;
let testApi: ServerTestApi | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(registerWindowsAddin).mockReset();
  vi.mocked(unregisterWindowsAddin).mockReset();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-setup-state-'));
  stateFile = path.join(stateDir, 'sidecar-state.json');
});

afterEach(async () => {
  await client?.close();
  await testApi?.server.close();
  testApi?.resetForTests();
  client = undefined;
  testApi = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function connectSetup(statePath: string | undefined = stateFile) {
  vi.stubEnv('MCP_OFFICE_SIDECAR_STATE', statePath);
  // Set Windows before import so module-level platform checks use the same branch as the handler.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const serverModule = (await import('../src/index.js')) as unknown as { __test: ServerTestApi };
  testApi = serverModule.__test;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await testApi.server.connect(serverTransport);
  client = new Client({ name: 'setup-windows-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return testApi;
}

async function setup(action: 'install' | 'uninstall') {
  const result = await client!.callTool({ name: 'rebel_office_setup', arguments: { action } });
  const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
  expect(parsed).toMatchObject({ app: 'all', action: 'setup' });
  expect(result.isError === true).toBe(!parsed.ok);
  return parsed;
}

describe('Windows setup tool', () => {
  it('uninstalls after normal shutdown has removed the state file', async () => {
    await connectSetup();
    await expect(fs.stat(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifestPath = path.join(stateDir, 'manifest.xml');
    vi.mocked(unregisterWindowsAddin).mockImplementation(async () => ({
      app: 'all', path: manifestPath, status: 'removed',
    }));

    const result = await setup('uninstall');
    expect(result).toMatchObject({ ok: true, data: { summary: expect.stringContaining('all: removed') } });
    expect(result.data.summary).toContain('On Windows, the add-in stays removed only while the Office connection is turned off in Rebel, because the connector registers it again whenever it starts.');
    expect(unregisterWindowsAddin).toHaveBeenCalledExactlyOnceWith(manifestPath);
    expect(registerWindowsAddin).not.toHaveBeenCalled();
  });

  it('reports a missing state directory configuration without calling the registry', async () => {
    // Empty configuration is also treated as absent by the server.
    await connectSetup('');
    expect(await setup('uninstall')).toMatchObject({ ok: false, error: { code: 'SIDECAR_ERROR', message: expect.stringContaining("all: failed (The Office sidecar state directory isn't configured.)") } });
    expect(unregisterWindowsAddin).not.toHaveBeenCalled();
  });

  it.each(['installed', 'unchanged'] as const)('reports a completed install for %s registration', async (status) => {
    const api = await connectSetup();
    const manifestPath = path.join(stateDir, 'manifest.xml');
    // Exercise the handler's real lazy-start path with the existing spawn seam;
    // no sidecar process or network socket is needed for manifest installation.
    api.setSpawnSidecarAndWaitForTests(async () => {
      await fs.writeFile(stateFile, JSON.stringify({ port: 52100, token: 'test-token', manifestPath }));
    });
    vi.mocked(registerWindowsAddin).mockImplementation(async () => ({
      app: 'all', path: manifestPath, status,
    }));

    const result = await setup('install');
    expect(result.ok).toBe(true);
    const text = result.data.summary;
    expect(text).toContain('Install manifest: done');
    expect(text).toContain('Home tab');
    expect(text).toContain('Developer Add-ins');
    expect(text).toContain(`all: ${status}`);
    expect(registerWindowsAddin).toHaveBeenCalledExactlyOnceWith(manifestPath);
  });
});


it('does not report setup success when registration fails', async () => {
  const api = await connectSetup();
  api.setSpawnSidecarAndWaitForTests(async () => {
    await fs.writeFile(stateFile, JSON.stringify({ port: 52100, token: 'test-token', manifestPath: path.join(stateDir, 'manifest.xml') }));
  });
  vi.mocked(registerWindowsAddin).mockResolvedValue({ app: 'all', path: stateDir, status: 'failed', error: 'Registration denied' });
  expect(await setup('install')).toMatchObject({ ok: false, error: { code: 'SIDECAR_ERROR', message: expect.stringContaining('Registration denied') } });
});

it('reports a failed registry delete on uninstall', async () => {
  await connectSetup();
  vi.mocked(unregisterWindowsAddin).mockResolvedValue({ app: 'all', path: stateDir, status: 'failed', error: 'Delete denied' });
  expect(await setup('uninstall')).toMatchObject({ ok: false, error: { code: 'SIDECAR_ERROR', message: expect.stringContaining('Delete denied') } });
});
