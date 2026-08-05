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
  it('should write through a single fd into a fresh private staging directory', async () => {
    const tmpDir = os.tmpdir();
    const requested = resolveTempOutputPath(path.join(tmpDir, `zendesk-writer-${process.pid}.json`));
    const writer = await createExclusiveFileWriter(requested);
    await writer.write('[1,');
    await writer.write('2]');
    await writer.close();

    // The write does NOT land at the requested path…
    expect(fs.existsSync(requested)).toBe(false);
    // …it lands inside a fresh per-export private directory directly under
    // the canonical temp root, preserving the requested file name.
    const tmpRoot = fs.realpathSync(tmpDir);
    const stagingDir = path.dirname(writer.filePath);
    expect(path.basename(writer.filePath)).toBe(`zendesk-writer-${process.pid}.json`);
    expect(path.dirname(stagingDir)).toBe(tmpRoot);
    expect(path.basename(stagingDir)).toMatch(/^zendesk-export-/);
    expect(fs.lstatSync(stagingDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(stagingDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(writer.filePath, 'utf8')).toBe('[1,2]');
    expect(fs.statSync(writer.filePath).mode & 0o777).toBe(0o600);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it('should never overwrite or follow a pre-existing file at the requested path', async () => {
    const tmpDir = os.tmpdir();
    const requested = path.join(tmpDir, `zendesk-existing-${process.pid}.json`);
    fs.writeFileSync(requested, 'original');
    try {
      const writer = await createExclusiveFileWriter(requested);
      await writer.write('export');
      await writer.close();
      // The pre-existing file is untouched and the export went elsewhere.
      expect(fs.readFileSync(requested, 'utf8')).toBe('original');
      expect(fs.readFileSync(writer.filePath, 'utf8')).toBe('export');
      fs.rmSync(path.dirname(writer.filePath), { recursive: true, force: true });
    } finally {
      fs.unlinkSync(requested);
    }
  });

  it('should never follow a final-component symlink at the requested path', async () => {
    const tmpDir = os.tmpdir();
    const target = path.join(tmpDir, `zendesk-symlink-target-${process.pid}.json`);
    const linkPath = path.join(tmpDir, `zendesk-symlink-leaf-${process.pid}.json`);
    fs.writeFileSync(target, 'sensitive');
    fs.symlinkSync(target, linkPath);
    try {
      const writer = await createExclusiveFileWriter(linkPath);
      await writer.write('export');
      await writer.close();
      expect(fs.readFileSync(target, 'utf8')).toBe('sensitive');
      expect(fs.readFileSync(writer.filePath, 'utf8')).toBe('export');
      fs.rmSync(path.dirname(writer.filePath), { recursive: true, force: true });
    } finally {
      fs.unlinkSync(linkPath);
      fs.unlinkSync(target);
    }
  });

  it('should be immune to a parent-directory swap between validation and write', async () => {
    // Adversarial regression: the checked parent directory is replaced by a
    // symlink (pointing at an attacker-controlled dir inside the temp root)
    // after resolveTempOutputPath validated the path. The write must not be
    // redirected through the symlink.
    const tmpDir = os.tmpdir();
    const attackerDir = fs.mkdtempSync(path.join(tmpDir, 'zendesk-attacker-'));
    const parent = path.join(tmpDir, `zendesk-parent-${process.pid}`);
    fs.mkdirSync(parent);
    const requested = path.join(parent, 'export.json');

    // Validation happens against the real parent directory…
    expect(() => resolveTempOutputPath(requested)).not.toThrow();
    // …then the attacker swaps it for a symlink before the write.
    fs.rmdirSync(parent);
    fs.symlinkSync(attackerDir, parent);

    try {
      const writer = await createExclusiveFileWriter(requested);
      await writer.write('confidential-export');
      await writer.close();

      // Nothing was written through the swapped parent…
      expect(fs.readdirSync(attackerDir)).toEqual([]);
      // …and the content is only inside the private staging directory.
      expect(fs.readFileSync(writer.filePath, 'utf8')).toBe('confidential-export');
      const tmpRoot = fs.realpathSync(tmpDir);
      expect(fs.realpathSync(writer.filePath).startsWith(tmpRoot + path.sep)).toBe(true);
      fs.rmSync(path.dirname(writer.filePath), { recursive: true, force: true });
    } finally {
      fs.unlinkSync(parent);
      fs.rmdirSync(attackerDir);
    }
  });

  it('discard() should remove the file and its private staging directory', async () => {
    const tmpDir = os.tmpdir();
    const requested = resolveTempOutputPath(path.join(tmpDir, `zendesk-discard-${process.pid}.json`));
    const writer = await createExclusiveFileWriter(requested);
    await writer.write('partial');
    const stagingDir = path.dirname(writer.filePath);
    await writer.discard();
    expect(fs.existsSync(writer.filePath)).toBe(false);
    expect(fs.existsSync(stagingDir)).toBe(false);
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
