import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyEffectiveTrust, readCertificatePair } from '../src/certificates/effectiveTrust.js';
import { runCertificateCommand } from '../src/certificates/ownedCommand.js';
import { TLS_CERT, TLS_KEY } from './tls-fixture.js';

const paths = { caCertificatePath: TLS_CERT, localhostCertificatePath: TLS_CERT, localhostKeyPath: TLS_KEY };
afterEach(() => vi.restoreAllMocks());

describe('effective system trust', () => {
  it('checks the SSL hostname without supplying a trust anchor', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(verifyEffectiveTrust({ ...paths, platform: 'darwin', certificateName: 'Test CA', run })).resolves.toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith('security', ['verify-cert', '-c', TLS_CERT, '-p', 'ssl', '-s', 'localhost']);
  });

  it.each([
    [true, true, true, true], [false, true, true, false], [true, false, true, false], [true, true, false, false],
  ])('Windows chain=%s store=%s issuer=%s => trusted=%s', async (chainValid, storeMatches, issuerMatches, expected) => {
    const run = vi.fn(async (_file: string, args: readonly string[]) => ({
      stdout: `${args[args.indexOf('-OutputMarker') + 1]}\n${JSON.stringify({ chainValid, storeMatches, issuerMatches, chainStatus: chainValid ? [] : ['PartialChain'] })}\n`, stderr: '',
    }));
    await expect(verifyEffectiveTrust({ ...paths, platform: 'win32', certificateName: 'Test CA', run })).resolves.toBe(expected);
    expect(run.mock.calls[0]?.[1]).toContain('-NoProfile');
  });

  it('Windows diagnostic ConvertTo-Json wrappers cannot change a trusted verdict', async () => {
    const run = async (_file: string, args: readonly string[]) => ({
      stdout: `${args[args.indexOf('-OutputMarker') + 1]}\n${JSON.stringify({
        chainValid: true, storeMatches: true, issuerMatches: true,
        chainStatus: { value: ['NoError'], Count: 1 },
      })}`, stderr: '',
    });
    await expect(verifyEffectiveTrust({ ...paths, platform: 'win32', certificateName: 'Test CA', run })).resolves.toBe(true);
  });

  it('negative Windows diagnostics contain only bounded status names', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = async (_file: string, args: readonly string[]) => ({
      stdout: `${args[args.indexOf('-OutputMarker') + 1]}\n${JSON.stringify({
        chainValid: false, storeMatches: true, issuerMatches: true,
        chainStatus: { value: ['PartialChain', 'UntrustedRoot', 'private details\n', 'A'.repeat(65), ...Array(20).fill('NotTimeValid')], Count: 24 },
      })}`, stderr: '',
    });
    await expect(verifyEffectiveTrust({ ...paths, platform: 'win32', certificateName: 'Test CA', run })).resolves.toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith('[office-cert] chain-status=PartialChain,UntrustedRoot,NotTimeValid,NotTimeValid,NotTimeValid,NotTimeValid,NotTimeValid,NotTimeValid\n');
  });

  it('plain nonzero command exits never signal a reaped PID', async () => {
    const kill = vi.spyOn(process, 'kill');
    await expect(runCertificateCommand(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 2_000 })).rejects.toMatchObject({ code: 7 });
    expect(kill).not.toHaveBeenCalled();
  });

  it('the maintained Windows script gates its verdict on the Build result', async () => {
    const script = await fs.readFile(new URL('../src/certificates/verify.ps1', import.meta.url), 'utf8');
    const policy = '$chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck';
    expect(script).toContain(policy);
    expect(script.indexOf(policy)).toBeLessThan(script.indexOf('$chainValid = $chain.Build($leaf)'));
    expect(script).toContain('$chainValid = $chain.Build($leaf)');
    expect(script).toContain('chainStatus = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })');
    expect(script).toContain('chainValid = [bool]$chainValid');
    expect(script).not.toContain('Out-Null');
  });

  it.each(['spawn error', 'timeout', 'unrecognized OS failure'])('Mac %s is unknown rather than trusted or renewable', async mode => {
    const failure = mode === 'unrecognized OS failure'
      ? Object.assign(new Error('OS failure'), { code: 7, stderr: 'unexpected failure' }) : new Error(mode);
    await expect(verifyEffectiveTrust({ ...paths, platform: 'darwin', certificateName: 'Test CA', run: async () => { throw failure; } })).rejects.toBe(failure);
  });

  it('missing and mismatched managed pairs fail read-only', async () => {
    expect(readCertificatePair({ ...paths, localhostKeyPath: `${TLS_KEY}-missing` })).toBeNull();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-mismatch-'));
    try {
      const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const key = path.join(dir, 'other.key');
      await fs.writeFile(key, other.privateKey);
      expect(readCertificatePair({ ...paths, localhostKeyPath: key })).toBeNull();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('the built importable verifier loads without starting a server or evaluating trust', async () => {
    const moduleUrl = new URL('../dist/certificates/effectiveTrust.js', import.meta.url).href;
    const built = await import(/* @vite-ignore */ moduleUrl) as { verifyEffectiveTrust: unknown };
    expect(typeof built.verifyEffectiveTrust).toBe('function');
    await expect(fs.stat(new URL('../dist/certificates/verify.ps1', import.meta.url))).resolves.toBeDefined();
  });

  it('pending standalone approval times out and cleans the owned installer tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-approval-timeout-'));
    const pidFile = path.join(dir, 'child.pid');
    const groupFile = path.join(dir, 'installer.group');
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      if(process.platform !== 'win32') fs.writeFileSync(${JSON.stringify(groupFile)}, require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)]));
      process.stdout.write('Installing CA certificate...\\n'); setInterval(()=>{},1000);`;
    let pid: number | undefined;
    try {
      await expect(runCertificateCommand(process.execPath, ['-e', script], { timeoutMs: 1_000 })).rejects.toThrow('timed out');
      pid = Number(await fs.readFile(pidFile, 'utf8'));
      expect(() => process.kill(pid!, 0)).toThrow();
      if (process.platform !== 'win32') expect((await fs.readFile(groupFile, 'utf8')).trim())
        .toBe(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
