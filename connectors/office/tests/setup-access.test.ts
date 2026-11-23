import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { getHttpsServerOptions } from 'office-addin-dev-certs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/sidecar/manifest.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sidecar/manifest.js')>(),
  installManifestsToWefFolders: vi.fn(),
}));

let dir: string;
let client: Client;
let api: { server: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> }; setSpawnSidecarAndWaitForTests: (fn: () => Promise<void>) => void; resetForTests: () => void };
let install: ReturnType<typeof vi.fn>;
let priorExitListeners: ReturnType<typeof process.listeners>;
const rawError = "EPERM: open '/Users/private-person/Library/Containers/manifest.xml'";

beforeEach(async () => {
  vi.resetModules();
  priorExitListeners = process.listeners('exit');
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-setup-access-'));
  vi.stubEnv('MCP_OFFICE_SIDECAR_STATE', path.join(dir, 'sidecar-state.json'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  api = (await import('../src/index.js')).__test;
  install = vi.mocked((await import('../src/sidecar/manifest.js')).installManifestsToWefFolders);
  install.mockReset();
  api.setSpawnSidecarAndWaitForTests(async () => {
    await fsp.writeFile(path.join(dir, 'sidecar-state.json'), JSON.stringify({ port: 52100, token: 'test-token', pid: process.pid, manifestPath: path.join(dir, 'manifest.xml') }));
  });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await api.server.connect(remote);
  client = new Client({ name: 'office-access-test', version: '0.0.0' });
  await client.connect(local);
});

afterEach(async () => {
  vi.useRealTimers();
  await client?.close();
  await api?.server.close();
  api?.resetForTests();
  // Fresh module imports add a process-exit lock cleanup; remove only this test's additions.
  for (const listener of process.listeners('exit')) {
    if (!priorExitListeners.includes(listener)) process.removeListener('exit', listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fsp.rm(dir, { recursive: true, force: true });
});

async function call(name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(result.isError === true).toBe(!body.ok);
  expect(body).toMatchObject({ app: 'all' });
  return body;
}

it.each([
  ['read-target', 'EPERM', 'OFFICE_ACCESS_BLOCKED', false],
  ['read-source', 'EPERM', 'SIDECAR_ERROR', true],
  ['write-target', 'EACCES', 'SIDECAR_ERROR', true],
  ['write-target', 'ENOSPC', 'SIDECAR_ERROR', true],
  [undefined, undefined, 'SIDECAR_ERROR', true],
] as const)('setup reports %s/%s without paths or success guidance', async (step, code, expectedCode, retryable) => {
  install.mockResolvedValue([{ app: 'word', path: '/Users/private-person/private', status: 'failed', error: rawError, step, code }]);
  const result = await call('rebel_office_setup', { action: 'install' });
  expect(install).toHaveBeenCalledExactlyOnceWith(dir);
  expect(result).toMatchObject({ ok: false, action: 'setup', error: { code: expectedCode, retryable } });
  expect(result.error.message).toContain('word: failed');
  if (step) expect(result.error.message).toContain(step);
  if (code) expect(result.error.message).toContain(code);
  expect(JSON.stringify(result)).not.toContain('/Users/');
  expect(JSON.stringify(result)).not.toContain('Next steps');
  expect(JSON.stringify(result)).not.toContain('Home tab');
  if (expectedCode === 'OFFICE_ACCESS_BLOCKED') {
    expect(result.error.fix).toContain("If they chose Don't Allow");
    expect(result.error.fix).toContain("if asked");
    expect(result.error.fix).toContain("Don't retry until they say they have");
  }
});

it('keeps successful setup details safe and includes next steps', async () => {
  install.mockResolvedValue([{ app: 'word', path: '/Users/private-person/private', status: 'unchanged' }]);
  const result = await call('rebel_office_setup', { action: 'install' });
  expect(result).toMatchObject({ ok: true, data: { steps: [{ details: [{ app: 'word', status: 'unchanged' }] }] } });
  expect(result.data.summary).toContain('Next steps');
  expect(JSON.stringify(result)).not.toContain('/Users/');
});

it('uninstall target EPERM keeps generic removal advice with no raw error', async () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error(rawError), { code: 'EPERM' }); });
  const result = await call('rebel_office_setup', { action: 'uninstall' });
  expect(result).toMatchObject({ ok: false, error: { code: 'SIDECAR_ERROR', retryable: true } });
  expect(result.error.fix).not.toMatch(/adding|Don't Allow|choose Allow/);
  expect(result.error.message).toContain('word: failed');
  expect(JSON.stringify(result)).not.toContain('/Users/');
});

it('bounded managed lock wait explains still starting without running a second installer', async () => {
  // A live different pid holds the real lock; no process is spawned or killed.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  await fsp.writeFile(path.join(dir, 'sidecar.lock'), '2147483000');
  vi.useFakeTimers();
  const response = call('rebel_office_setup', { action: 'install' });
  await vi.advanceTimersByTimeAsync(31_000);
  const result = await response;
  expect(result).toMatchObject({ ok: false, error: { code: 'SIDECAR_NOT_RUNNING' } });
  expect(result.error.message).toContain('still starting');
  expect(result.error.message).toBe("Rebel's Office connection is still starting.");
  expect(result.error.message).not.toContain('Failed');
  expect(result.error.message).not.toContain('If');
  expect(result.error.fix).toContain('If');
  expect(result.error.fix).toContain('question');
  expect(result.error.fix).not.toContain('Enable');
  expect(install).not.toHaveBeenCalled();
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each([
  ['office-access-blocked', 'OFFICE_ACCESS_BLOCKED'],
  ['office-setup-timeout', 'OFFICE_SETUP_TIMEOUT'],
  ['wef-install-failed', 'SIDECAR_ERROR'],
  [undefined, undefined],
] as const)('status honours existing setup diagnostics (%s) before suggesting the Office button', async (lastEagerStartErrorCode, code) => {
  // This suite's shared setup mocks the certificate library; only a synthetic TLS fixture is used.
  const server = https.createServer(await getHttpsServerOptions(), (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: { word: false, excel: false, powerpoint: false } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    await fsp.writeFile(path.join(dir, 'sidecar-state.json'), JSON.stringify({ port: address.port, token: 'test-token', pid: process.pid, lastEagerStartErrorCode }));
    const result = await call('rebel_office_status');
    expect(result).toMatchObject({ ok: true, action: 'status', data: { sidecar: 'running' } });
    if (code) {
      expect(result.data.setup).toMatchObject({ code, fix: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain('Home tab');
      expect(result.data).not.toHaveProperty('fix');
    } else {
      expect(result.data.fix).toContain('Home tab');
      expect(result.data).not.toHaveProperty('setup');
    }
    expect(install).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('status without running state retains the setup-timeout failure and conditional fix', async () => {
  await fsp.writeFile(path.join(dir, 'sidecar-last-failure.json'), JSON.stringify({ code: 'office-setup-timeout', at: Date.now() }));
  const result = await call('rebel_office_status');
  expect(result).toMatchObject({ ok: false, error: { code: 'OFFICE_SETUP_TIMEOUT', retryable: false } });
  expect(result.error.fix).toContain('If');
  expect(result.error.fix).toContain('still asking');
  expect(result.error.message).toContain('last recorded automatic setup attempt');
  expect(result.error.fix).toContain('If the add-in is still unavailable');
  expect(result.error.fix).toContain('later manual setup may have succeeded');
  expect(result.error.fix).toContain('Microsoft Office connection settings in Rebel');
  expect(result.error.fix).toContain('If that action is unavailable');
  expect(result.error.fix).toContain('turn on or connect Microsoft Office there and wait for its connection status to update.');
  expect(JSON.stringify(result)).not.toContain('Home tab');
});

it.each(['office-access-blocked', 'office-setup-timeout', 'wef-install-failed'] as const)(
  'status after successful manual setup keeps %s historical even with all apps connected', async lastEagerStartErrorCode => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const server = https.createServer(await getHttpsServerOptions(), (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: { word: true, excel: true, powerpoint: true } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      const stateFile = path.join(dir, 'sidecar-state.json');
      await fsp.writeFile(stateFile, JSON.stringify({ port: address.port, token: 'test-token', pid: 2147483000, manifestPath: path.join(dir, 'manifest.xml'), lastEagerStartErrorCode }));
      install.mockResolvedValue(['word', 'excel', 'powerpoint'].map(app => ({ app, path: dir, status: 'installed' })));
      expect((await call('rebel_office_setup', { action: 'install' })).ok).toBe(true);
      expect(JSON.parse(await fsp.readFile(stateFile, 'utf8')).lastEagerStartErrorCode).toBe(lastEagerStartErrorCode);
      const result = await call('rebel_office_status');
      expect(result).toMatchObject({ ok: true, data: { apps: { word: 'connected', excel: 'connected', powerpoint: 'connected' } } });
      expect(result.data.setup.code).toBe(lastEagerStartErrorCode === 'office-access-blocked' ? 'OFFICE_ACCESS_BLOCKED' : lastEagerStartErrorCode === 'office-setup-timeout' ? 'OFFICE_SETUP_TIMEOUT' : 'SIDECAR_ERROR');
      expect(result.data.setup.message).toContain('last recorded automatic setup attempt');
      expect(result.data.setup.message).toContain('later manual setup may have succeeded');
      expect(result.data.setup.fix).toMatch(/^If the add-in is still unavailable/);
      expect(result.data).not.toHaveProperty('fix');
      expect(JSON.stringify(result)).not.toContain('Home tab');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  },
);
