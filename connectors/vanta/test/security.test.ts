import { describe, expect, it } from 'vitest';

import { validateDocumentUrl, VantaApiError } from '../src/api.js';

describe('validateDocumentUrl — SSRF guard', () => {
  describe('accepts safe URLs', () => {
    it('accepts a public https:// URL', () => {
      const result = validateDocumentUrl('https://example.com/policy.pdf');
      expect(result.toString()).toBe('https://example.com/policy.pdf');
    });

    it('accepts https:// with path and query', () => {
      const result = validateDocumentUrl('https://docs.example.com/path/file.pdf?token=x');
      expect(result.hostname).toBe('docs.example.com');
    });

    it('accepts https:// with non-standard port', () => {
      const result = validateDocumentUrl('https://example.com:8443/doc.pdf');
      expect(result.port).toBe('8443');
    });
  });

  describe('rejects non-https schemes', () => {
    const denySchemes: Array<{ name: string; url: string }> = [
      { name: 'file:', url: 'file:///etc/passwd' },
      { name: 'http:', url: 'http://example.com/policy.pdf' },
      { name: 'javascript:', url: 'javascript:alert(1)' },
      { name: 'data:', url: 'data:text/plain,abc' },
    ];

    for (const { name, url } of denySchemes) {
      it(`rejects ${name}`, () => {
        expect(() => validateDocumentUrl(url)).toThrowError(VantaApiError);
        try {
          validateDocumentUrl(url);
        } catch (e) {
          if (e instanceof VantaApiError) {
            expect(e.code).toBe('CONFIG_INVALID');
            expect(e.action_required).toBeTruthy();
            expect(e.next_step).toMatch(/https:\/\//);
          }
        }
      });
    }
  });

  describe('rejects loopback and 0.0.0.0', () => {
    const denyLoopback = [
      'https://localhost/doc.pdf',
      'https://127.0.0.1/doc.pdf',
      'https://127.0.0.255/doc.pdf',
      'https://[::1]/doc.pdf',
      'https://0.0.0.0/doc.pdf',
    ];

    for (const url of denyLoopback) {
      it(`rejects ${url}`, () => {
        expect(() => validateDocumentUrl(url)).toThrowError(VantaApiError);
      });
    }
  });

  describe('rejects RFC1918 private ranges', () => {
    const denyRfc1918 = [
      'https://10.0.0.1/doc.pdf',
      'https://10.255.255.255/doc.pdf',
      'https://192.168.0.1/doc.pdf',
      'https://192.168.1.100/doc.pdf',
      'https://172.16.0.1/doc.pdf',
      'https://172.20.10.5/doc.pdf',
      'https://172.31.255.255/doc.pdf',
    ];

    for (const url of denyRfc1918) {
      it(`rejects ${url}`, () => {
        expect(() => validateDocumentUrl(url)).toThrowError(VantaApiError);
      });
    }

    // Edge of RFC1918 range — must NOT be in the deny block
    it('accepts 172.15.0.1 (just outside RFC1918 172.16/12 range)', () => {
      expect(() => validateDocumentUrl('https://172.15.0.1/doc.pdf')).not.toThrow();
    });

    it('accepts 172.32.0.1 (just outside RFC1918 172.16/12 range)', () => {
      expect(() => validateDocumentUrl('https://172.32.0.1/doc.pdf')).not.toThrow();
    });
  });

  describe('rejects 169.254.0.0/16 link-local (includes IMDS)', () => {
    it('rejects 169.254.169.254 (AWS / Azure / GCP IMDS)', () => {
      expect(() => validateDocumentUrl('https://169.254.169.254/latest/meta-data/'))
        .toThrowError(VantaApiError);
    });

    it('rejects other 169.254.x.x addresses', () => {
      expect(() => validateDocumentUrl('https://169.254.1.1/'))
        .toThrowError(VantaApiError);
    });
  });

  describe('rejects IPv6 loopback / link-local / ULA', () => {
    it('rejects [::1]', () => {
      expect(() => validateDocumentUrl('https://[::1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects link-local fe80::', () => {
      expect(() => validateDocumentUrl('https://[fe80::1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects unique-local fc00::/7 (fc prefix)', () => {
      expect(() => validateDocumentUrl('https://[fc00::1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects unique-local fd00::/8 (fd prefix)', () => {
      expect(() => validateDocumentUrl('https://[fd00::1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });
  });

  describe('rejects malformed URLs', () => {
    it('rejects an empty string', () => {
      expect(() => validateDocumentUrl('')).toThrowError(VantaApiError);
    });

    it('rejects a non-URL string', () => {
      expect(() => validateDocumentUrl('not a url')).toThrowError(VantaApiError);
    });
  });

  describe('produces structured recovery-contract errors', () => {
    it('every rejection carries action_required and next_step', () => {
      try {
        validateDocumentUrl('file:///etc/passwd');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VantaApiError);
        if (e instanceof VantaApiError) {
          expect(e.code).toBe('CONFIG_INVALID');
          expect(e.action_required.length).toBeGreaterThan(0);
          expect(e.next_step.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
