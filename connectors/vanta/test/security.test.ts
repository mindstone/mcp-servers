import { afterEach, describe, expect, it } from 'vitest';

import {
  setDnsLookupForTesting,
  validateDocumentUrl,
  validateDocumentUrlWithDns,
  VantaApiError,
} from '../src/api.js';

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

  describe('rejects other RFC 6890 special-use ranges (adversarial R1 fix)', () => {
    const denySpecialUse = [
      // RFC 6598 shared/CGNAT — reachable non-public hosts (e.g. Tailscale)
      'https://100.64.0.1/secret.pdf',
      'https://100.100.100.100/secret.pdf',
      'https://100.127.255.254/secret.pdf',
      // RFC 2544 benchmarking
      'https://198.18.0.1/doc.pdf',
      'https://198.19.255.1/doc.pdf',
      // TEST-NET documentation ranges (fail-closed parity with 2001:db8::/32)
      'https://192.0.2.1/doc.pdf',
      'https://198.51.100.1/doc.pdf',
      'https://203.0.113.1/doc.pdf',
      // Deprecated 6to4 relay anycast
      'https://192.88.99.1/doc.pdf',
      // Multicast + reserved/broadcast
      'https://224.0.0.1/doc.pdf',
      'https://239.255.255.255/doc.pdf',
      'https://240.0.0.1/doc.pdf',
      'https://255.255.255.255/doc.pdf',
    ];

    for (const url of denySpecialUse) {
      it(`rejects ${url}`, () => {
        expect(() => validateDocumentUrl(url)).toThrowError(VantaApiError);
      });
    }

    // Edges of the CGNAT /10 — must NOT be in the deny block
    it('accepts 100.63.255.1 (just below 100.64.0.0/10)', () => {
      expect(() => validateDocumentUrl('https://100.63.255.1/doc.pdf')).not.toThrow();
    });

    it('accepts 100.128.0.1 (just above 100.64.0.0/10)', () => {
      expect(() => validateDocumentUrl('https://100.128.0.1/doc.pdf')).not.toThrow();
    });

    it('rejects IPv4-mapped IPv6 shared range [::ffff:100.64.0.1]', () => {
      expect(() => validateDocumentUrl('https://[::ffff:100.64.0.1]/secret.pdf'))
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

    it('rejects IPv6 unspecified ::', () => {
      expect(() => validateDocumentUrl('https://[::]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects IPv6 documentation range 2001:db8::/32', () => {
      expect(() => validateDocumentUrl('https://[2001:db8::1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });
  });

  describe('rejects IPv4-mapped IPv6 (C6 fix)', () => {
    it('rejects [::ffff:127.0.0.1] (mapped loopback)', () => {
      expect(() => validateDocumentUrl('https://[::ffff:127.0.0.1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects [::ffff:10.0.0.1] (mapped RFC1918)', () => {
      expect(() => validateDocumentUrl('https://[::ffff:10.0.0.1]/doc.pdf'))
        .toThrowError(VantaApiError);
    });

    it('rejects [::ffff:169.254.169.254] (mapped IMDS)', () => {
      expect(() => validateDocumentUrl('https://[::ffff:169.254.169.254]/doc.pdf'))
        .toThrowError(VantaApiError);
    });
  });

  describe('strips embedded user-info credentials', () => {
    it('drops https://user:pass@example.com', () => {
      const url = validateDocumentUrl('https://leaked-token:swordfish@example.com/doc.pdf');
      expect(url.toString()).not.toMatch(/leaked-token|swordfish/);
      expect(url.username).toBe('');
      expect(url.password).toBe('');
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

  describe('DNS resolution layer (C6 fix — anti-rebind defence in depth)', () => {
    afterEach(() => {
      setDnsLookupForTesting(null);
    });

    it('rejects hostnames whose A record resolves to loopback', async () => {
      setDnsLookupForTesting(async () => [{ address: '127.0.0.1', family: 4 }]);
      await expect(
        validateDocumentUrlWithDns('https://internal-spoof.example.com/doc.pdf'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('rejects hostnames whose A record resolves to IMDS', async () => {
      setDnsLookupForTesting(async () => [{ address: '169.254.169.254', family: 4 }]);
      await expect(
        validateDocumentUrlWithDns('https://imds-spoof.example.com/'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('rejects hostnames whose AAAA record resolves to IPv6 loopback', async () => {
      setDnsLookupForTesting(async () => [{ address: '::1', family: 6 }]);
      await expect(
        validateDocumentUrlWithDns('https://v6-spoof.example.com/'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('rejects hostnames whose AAAA record resolves to IPv4-mapped loopback', async () => {
      setDnsLookupForTesting(async () => [{ address: '::ffff:127.0.0.1', family: 6 }]);
      await expect(
        validateDocumentUrlWithDns('https://mapped-spoof.example.com/'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('rejects when DNS lookup itself fails (fail-closed)', async () => {
      setDnsLookupForTesting(async () => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      });
      await expect(
        validateDocumentUrlWithDns('https://nonexistent.example.invalid/'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('accepts hostnames whose A records are all public', async () => {
      setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
      const url = await validateDocumentUrlWithDns('https://example.com/doc.pdf');
      expect(url.hostname).toBe('example.com');
    });

    it('rejects when any A record is internal (mixed records)', async () => {
      setDnsLookupForTesting(async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);
      await expect(
        validateDocumentUrlWithDns('https://mixed-spoof.example.com/'),
      ).rejects.toThrowError(VantaApiError);
    });

    it('skips DNS for literal IP hostnames (syntactic check is authoritative)', async () => {
      let dnsCalls = 0;
      setDnsLookupForTesting(async () => {
        dnsCalls += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      });
      await expect(
        validateDocumentUrlWithDns('https://127.0.0.1/doc.pdf'),
      ).rejects.toThrowError(VantaApiError);
      expect(dnsCalls).toBe(0);
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
