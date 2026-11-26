import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TLS_CERT, TLS_KEY } from './tls-fixture.js';
import { startOfficeSidecar } from '../src/sidecar/index.js';

vi.unmock('../src/certificates/setup.js');
const files = vi.hoisted(() => ({ cert: '', key: '' }));
vi.mock('office-addin-dev-certs/lib/defaults.js', () => ({
  get caCertificatePath() { return files.cert || TLS_CERT; },
  get localhostCertificatePath() { return files.cert || TLS_CERT; },
  get localhostKeyPath() { return files.key || TLS_KEY; },
  certificateName: 'Developer CA for Microsoft Office Add-ins', daysUntilCertificateExpires: 30, domain: ['localhost'],
}));
vi.mock('../src/certificates/ownedCommand.js', async original => ({
  ...await original<typeof import('../src/certificates/ownedCommand.js')>(), runCertificateCommand: vi.fn(),
}));

afterEach(() => { files.cert = ''; files.key = ''; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('declared certificate owner', () => {
  it('managed tripwire: never reaches getHttpsServerOptions', async () => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', 'rebel');
    const devCerts = await import('office-addin-dev-certs');
    const tripwire = vi.spyOn(devCerts, 'getHttpsServerOptions').mockRejectedValue(new Error('INSTALL-CAPABLE ENTRY CALLED'));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-owner-'));
    const reachedHttps = new Error('Read-only pair reached HTTPS server creation');
    vi.spyOn(https, 'createServer').mockImplementationOnce(() => { throw reachedHttps; });
    try {
      await expect(startOfficeSidecar({ stateDirectory: dir, port: 0 })).rejects.toBe(reachedHttps);
      expect(tripwire).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('certificate failures at the helper entry', () => {
  it('managed missing pair rejects before any stdout or install-capable call', async () => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', 'rebel');
    files.key = path.join(os.tmpdir(), `missing-office-key-${process.pid}`);
    const devCerts = await import('office-addin-dev-certs');
    const install = vi.spyOn(devCerts, 'getHttpsServerOptions');
    vi.spyOn(https, 'createServer').mockImplementationOnce(() => { throw new Error('HTTPS started without the managed pair'); });
    const stdout = vi.spyOn(process.stdout, 'write');
    await expect(startOfficeSidecar({ port: 0 })).rejects.toMatchObject({ code: 'CERT_NOT_TRUSTED' });
    expect(install).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('standalone Cancel then retry requests approval again and never starts', async () => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(https, 'createServer').mockImplementation(() => { throw new Error('HTTPS started without effective trust'); });
    const { runCertificateCommand } = await import('../src/certificates/ownedCommand.js');
    const run = vi.mocked(runCertificateCommand).mockReset().mockImplementation(async (_file, args) => {
      if (args[0] === 'verify-cert') throw Object.assign(new Error('negative'), { code: 1, stderr: 'CSSMERR_TP_NOT_TRUSTED' });
      throw new Error('authorization was canceled');
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const sidecar = await startOfficeSidecar({ port: 0, installToWefFolders: false }).catch(error => error);
      if (sidecar.stop) await sidecar.stop(); // The old implementation starts; avoid a leaked test server on red.
      expect(sidecar).toMatchObject({ code: 'CERT_NOT_TRUSTED' });
      expect(sidecar.message).not.toContain('Settings');
    }
    expect(run.mock.calls.filter(call => call[1][0] === 'add-trusted-cert')).toHaveLength(2);
  });

  it('standalone exits honestly when post-install effective trust remains negative', async () => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(https, 'createServer').mockImplementation(() => { throw new Error('HTTPS started without effective trust'); });
    const { runCertificateCommand } = await import('../src/certificates/ownedCommand.js');
    const run = vi.mocked(runCertificateCommand).mockReset().mockImplementation(async (_file, args) => {
      if (args[0] === 'verify-cert') throw Object.assign(new Error('negative'), { code: 1, stderr: 'CSSMERR_TP_NOT_TRUSTED' });
      return { stdout: 'Installing CA certificate...\n', stderr: '' };
    });
    const result = await startOfficeSidecar({ port: 0, installToWefFolders: false }).catch(error => error);
    if (result.stop) await result.stop();
    expect(result).toMatchObject({ code: 'CERT_NOT_TRUSTED' });
    expect(run.mock.calls.filter(call => call[1][0] === 'add-trusted-cert')).toHaveLength(1);
  });
});

describe('standalone inconclusive checks', () => {
  it.each([false, true])('unknown verdict is renewable only before install (post-install unknown=%s)', async postUnknown => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const { getSidecarHttpsOptions } = await import('../src/certificates/setup.js');
    const { runCertificateCommand } = await import('../src/certificates/ownedCommand.js');
    let installed = false;
    const run = vi.mocked(runCertificateCommand).mockReset().mockImplementation(async (_file, args) => {
      if (args[0] === 'add-trusted-cert') installed = true;
      if (args[0] === 'verify-cert' && (!installed || postUnknown)) throw Object.assign(new Error('private OS details'), { code: 7 });
      return { stdout: '', stderr: '' };
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    if (postUnknown) {
      await expect(getSidecarHttpsOptions()).rejects.toMatchObject({ code: 'CERT_NOT_TRUSTED' });
      expect(stderr).toHaveBeenCalledExactlyOnceWith('[office-cert] setup-failed cause=exit-7\n');
      expect(stderr.mock.calls.flat().join('')).not.toContain('private OS details');
    } else {
      await expect(getSidecarHttpsOptions()).resolves.toHaveProperty('cert');
    }
    expect(run.mock.calls.filter(call => call[1][0] === 'add-trusted-cert')).toHaveLength(1);
    expect(run.mock.calls.filter(call => call[1][0] === 'verify-cert')).toHaveLength(2);
  });

  it('missing pair is a definite negative and requests the bounded standalone install', async () => {
    vi.stubEnv('MCP_OFFICE_CERT_OWNER', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    files.key = `${TLS_KEY}-missing`;
    const { getSidecarHttpsOptions } = await import('../src/certificates/setup.js');
    const { runCertificateCommand } = await import('../src/certificates/ownedCommand.js');
    const run = vi.mocked(runCertificateCommand).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    await expect(getSidecarHttpsOptions()).rejects.toMatchObject({ code: 'CERT_NOT_TRUSTED' });
    expect(run.mock.calls.map(call => call[1][0])).toEqual(['add-trusted-cert']);
  });
});

describe('managed CLI certificate errors', () => {
  it.each(['missing', 'mismatched'])('%s pair gives coded stderr and empty stdout', async mode => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-cli-cert-'));
    const stdout = await fs.open(path.join(dir, 'stdout'), 'w');
    const stderr = await fs.open(path.join(dir, 'stderr'), 'w');
    try {
      const key = path.join(dir, 'localhost.key');
      if (mode === 'mismatched') {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        await fs.writeFile(key, pair.privateKey);
      }
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sidecar/cli.js', import.meta.url))], {
        env: {
          ...process.env, MCP_OFFICE_CERT_OWNER: 'rebel', MCP_OFFICE_SIDECAR_STATE_DIR: dir,
          OFFICE_TEST_TLS_CERT: TLS_CERT, OFFICE_TEST_TLS_KEY: key,
          NODE_OPTIONS: `--import ${new URL('./fixtures/dev-certs-loader.mjs', import.meta.url).href}`,
        }, stdio: ['ignore', stdout.fd, stderr.fd],
      });
      const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      expect(code).toBe(1);
      expect(await fs.readFile(path.join(dir, 'stdout'), 'utf8')).toBe('');
      expect(await fs.readFile(path.join(dir, 'stderr'), 'utf8')).toContain('CERT_NOT_TRUSTED');
    } finally {
      await stdout.close(); await stderr.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
