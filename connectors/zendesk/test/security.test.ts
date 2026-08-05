import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertValidSubdomain, ZendeskError } from '../src/types.js';
import { resolveTempOutputPath, createExclusiveFileWriter } from '../src/utils.js';

describe('Security — assertValidSubdomain', () => {
  it('should accept valid alphanumeric subdomains', () => {
    expect(() => assertValidSubdomain('testcorp')).not.toThrow();
    expect(() => assertValidSubdomain('my-company')).not.toThrow();
    expect(() => assertValidSubdomain('abc123')).not.toThrow();
    expect(() => assertValidSubdomain('a')).not.toThrow();
    expect(() => assertValidSubdomain('UPPER')).not.toThrow();
  });

  it('should reject path traversal attempts', () => {
    expect(() => assertValidSubdomain('../etc/passwd')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('../../root')).toThrow('Invalid Zendesk subdomain');
  });

  it('should reject subdomains with dots', () => {
    expect(() => assertValidSubdomain('foo.bar')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('test.zendesk.com')).toThrow('Invalid Zendesk subdomain');
  });

  it('should reject subdomains with spaces', () => {
    expect(() => assertValidSubdomain('foo bar')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain(' test')).toThrow('Invalid Zendesk subdomain');
  });

  it('should reject empty subdomains', () => {
    expect(() => assertValidSubdomain('')).toThrow('Invalid Zendesk subdomain');
  });

  it('should reject special characters', () => {
    expect(() => assertValidSubdomain('foo@bar')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('foo/bar')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('foo\\bar')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('foo;bar')).toThrow('Invalid Zendesk subdomain');
  });

  it('should reject subdomains starting or ending with hyphens', () => {
    expect(() => assertValidSubdomain('-startwith')).toThrow('Invalid Zendesk subdomain');
    expect(() => assertValidSubdomain('endwith-')).toThrow('Invalid Zendesk subdomain');
  });
});

describe('Security — resolveTempOutputPath', () => {
  it('should accept paths within tmpdir', () => {
    const tmpDir = os.tmpdir();
    const validPath = path.join(tmpDir, 'zendesk-export.json');
    expect(() => resolveTempOutputPath(validPath)).not.toThrow();
    expect(resolveTempOutputPath(validPath)).toBe(path.resolve(validPath));
  });

  it('should reject paths outside tmpdir', () => {
    expect(() => resolveTempOutputPath('/home/user/secret.json')).toThrow('output_path must be within the temp directory');
    expect(() => resolveTempOutputPath('/etc/passwd')).toThrow('output_path must be within the temp directory');
  });

  it('should reject /tmp-evil/ prefix bypass attempt', () => {
    // /tmp-evil starts with /tmp but is NOT within tmpdir
    const tmpDir = os.tmpdir();
    const evilPath = tmpDir + '-evil/data.json';
    expect(() => resolveTempOutputPath(evilPath)).toThrow('output_path must be within the temp directory');
  });

  it('should reject path traversal via ../', () => {
    const tmpDir = os.tmpdir();
    const traversalPath = path.join(tmpDir, '..', 'etc', 'passwd');
    expect(() => resolveTempOutputPath(traversalPath)).toThrow('output_path must be within the temp directory');
  });

  it('should reject a symlinked parent directory that escapes the temp root', () => {
    const tmpDir = os.tmpdir();
    const linkPath = path.join(tmpDir, `zendesk-symlink-escape-${process.pid}`);
    fs.symlinkSync(path.dirname(fs.realpathSync(tmpDir)), linkPath);
    try {
      // Lexically inside tmpdir, but the parent symlink resolves outside it.
      expect(() => resolveTempOutputPath(path.join(linkPath, 'evil.json')))
        .toThrow('output_path must be within the temp directory');
    } finally {
      fs.unlinkSync(linkPath);
    }
  });

  it('should accept a symlinked parent whose canonical target stays inside the temp root', () => {
    const tmpDir = os.tmpdir();
    const realDir = fs.mkdtempSync(path.join(tmpDir, 'zendesk-real-'));
    const linkPath = path.join(tmpDir, `zendesk-symlink-inside-${process.pid}`);
    fs.symlinkSync(realDir, linkPath);
    try {
      expect(() => resolveTempOutputPath(path.join(linkPath, 'ok.json'))).not.toThrow();
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmdirSync(realDir);
    }
  });

  it('should throw a structured ZendeskError (actionable, model-safe) for escapes', () => {
    try {
      resolveTempOutputPath('/etc/passwd');
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ZendeskError);
      expect(err.code).toBe('INVALID_OUTPUT_PATH');
      expect(err.resolution).toContain('temp');
    }
  });
});

describe('Security — createExclusiveFileWriter', () => {
  it('should write through a single fd and produce a 0o600 file', async () => {
    const tmpDir = os.tmpdir();
    const filePath = resolveTempOutputPath(path.join(tmpDir, `zendesk-writer-${process.pid}.json`));
    const writer = await createExclusiveFileWriter(filePath);
    await writer.write('[1,');
    await writer.write('2]');
    await writer.close();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('[1,2]');
    expect((fs.statSync(filePath).mode & 0o777)).toBe(0o600);
    fs.unlinkSync(filePath);
  });

  it('should refuse to overwrite an existing file (EEXIST fails closed)', async () => {
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `zendesk-existing-${process.pid}.json`);
    fs.writeFileSync(filePath, 'original');
    try {
      await expect(createExclusiveFileWriter(filePath)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
      // The existing file is untouched.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('should refuse a final-component symlink instead of following it', async () => {
    const tmpDir = os.tmpdir();
    const target = path.join(tmpDir, `zendesk-symlink-target-${process.pid}.json`);
    const linkPath = path.join(tmpDir, `zendesk-symlink-leaf-${process.pid}.json`);
    fs.writeFileSync(target, 'sensitive');
    fs.symlinkSync(target, linkPath);
    try {
      await expect(createExclusiveFileWriter(linkPath)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
      expect(fs.readFileSync(target, 'utf8')).toBe('sensitive');
    } finally {
      fs.unlinkSync(linkPath);
      fs.unlinkSync(target);
    }
  });
});

describe('Security — ZendeskError does not leak credentials', () => {
  it('should not include API tokens in error messages', () => {
    const error = new ZendeskError(
      'Authentication failed',
      'AUTH_FAILED',
      'API token is invalid or revoked. Check your Zendesk API token.',
    );
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('test-api-token');
    expect(serialized).not.toContain('Bearer');
    expect(error.message).toBe('Authentication failed');
    expect(error.code).toBe('AUTH_FAILED');
  });

  it('should preserve error information without credentials', () => {
    const error = new ZendeskError(
      'Rate limited. Please wait 10 seconds before retrying.',
      'RATE_LIMITED',
      'Wait 10 seconds and try again.',
    );
    expect(error.message).toContain('Rate limited');
    expect(error.resolution).toContain('Wait 10 seconds');
    expect(error.code).toBe('RATE_LIMITED');
  });
});
