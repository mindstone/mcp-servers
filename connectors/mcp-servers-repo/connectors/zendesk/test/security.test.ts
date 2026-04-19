import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { assertValidSubdomain, ZendeskError } from '../src/types.js';
import { resolveTempOutputPath } from '../src/utils.js';

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
