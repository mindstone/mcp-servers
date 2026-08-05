/**
 * SSRF anti-rebinding guard for remote source-image URLs.
 *
 * The textual host check alone was bypassable: a public-looking hostname
 * could resolve (or rebind) to loopback / link-local / RFC1918 space after
 * validation, and the hard-coded literal deny-list missed CGNAT
 * (100.64.0.0/10), reserved 192.0.0.0/24, and IPv4-mapped IPv6. These tests
 * pin the closed holes: full-range literal coverage, DNS resolution with
 * every A/AAAA record re-checked, fail-closed on unresolvable hosts, and
 * DNS re-validation on every redirect hop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  fetchRemoteImage,
  setDnsLookupForTesting,
  validateRemoteImageUrl,
  validateRemoteImageUrlWithDns,
} from '../src/tools/remote-image.js';
import { NanoBananaError } from '../src/types.js';

const PUBLIC_IP = '93.184.216.34'; // example.com's well-known public address

function expectUrlRejected(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => { throw new Error('expected URL_REJECTED, but validation passed'); },
    (error) => {
      expect(error).toBeInstanceOf(NanoBananaError);
      expect((error as NanoBananaError).code).toBe('URL_REJECTED');
    },
  );
}

afterEach(() => {
  setDnsLookupForTesting(null);
});

describe('validateRemoteImageUrl — literal non-public ranges', () => {
  it('accepts a public IP literal', () => {
    expect(() => validateRemoteImageUrl(`https://${PUBLIC_IP}/pic.png`)).not.toThrow();
  });

  it.each([
    ['CGNAT 100.64.0.0/10', 'https://100.64.0.1/pic.png'],
    ['IETF protocol assignments 192.0.0.0/24', 'https://192.0.0.1/pic.png'],
    ['benchmarking 198.18.0.0/15', 'https://198.18.0.1/pic.png'],
    ['multicast 224.0.0.0/4', 'https://224.0.0.1/pic.png'],
    ['reserved 240.0.0.0/4', 'https://240.0.0.1/pic.png'],
    ['unspecified 0.0.0.0', 'https://0.0.0.0/pic.png'],
    ['TEST-NET-1 192.0.2.0/24', 'https://192.0.2.1/pic.png'],
  ])('refuses %s', (_label, url) => {
    expect(() => validateRemoteImageUrl(url)).toThrowError(NanoBananaError);
  });

  it.each([
    ['dotted ::ffff:127.0.0.1', 'https://[::ffff:127.0.0.1]/pic.png'],
    ['dotted ::ffff:169.254.169.254', 'https://[::ffff:169.254.169.254]/pic.png'],
    ['hex ::ffff:7f00:1 (WHATWG-normalised)', 'https://[::ffff:7f00:1]/pic.png'],
    ['IPv6 loopback ::1', 'https://[::1]/pic.png'],
    ['IPv6 unspecified ::', 'https://[::]/pic.png'],
    ['IPv6 link-local fe80::1', 'https://[fe80::1]/pic.png'],
    ['IPv6 unique-local fd00::1', 'https://[fd00::1]/pic.png'],
  ])('refuses IPv4-mapped / non-public IPv6 literal: %s', (_label, url) => {
    expect(() => validateRemoteImageUrl(url)).toThrowError(NanoBananaError);
  });
});

describe('validateRemoteImageUrlWithDns — resolution re-check', () => {
  it('refuses a hostname resolving to loopback', async () => {
    setDnsLookupForTesting(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('refuses a hostname resolving to RFC1918 space', async () => {
    setDnsLookupForTesting(async () => [{ address: '10.1.2.3', family: 4 }]);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('refuses a hostname resolving to CGNAT space', async () => {
    setDnsLookupForTesting(async () => [{ address: '100.64.5.6', family: 4 }]);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('refuses a hostname resolving to IPv6 loopback', async () => {
    setDnsLookupForTesting(async () => [{ address: '::1', family: 6 }]);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('refuses when ANY resolved record is non-public', async () => {
    setDnsLookupForTesting(async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('fails closed when DNS resolution errors', async () => {
    setDnsLookupForTesting(async () => { throw new Error('ENOTFOUND'); });
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('fails closed when DNS resolves to zero addresses', async () => {
    setDnsLookupForTesting(async () => []);
    await expectUrlRejected(validateRemoteImageUrlWithDns('https://images.example.com/pic.png'));
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    setDnsLookupForTesting(async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    await expect(validateRemoteImageUrlWithDns('https://images.example.com/pic.png')).resolves.toBeInstanceOf(URL);
  });

  it('skips DNS for IP literals (already classified synchronously)', async () => {
    let called = 0;
    setDnsLookupForTesting(async () => { called += 1; return [{ address: '127.0.0.1', family: 4 }]; });
    await expect(validateRemoteImageUrlWithDns(`https://${PUBLIC_IP}/pic.png`)).resolves.toBeInstanceOf(URL);
    expect(called).toBe(0);
  });
});

describe('fetchRemoteImage — DNS re-validation on redirect hops', () => {
  it('refuses a redirect to a hostname that resolves to a private address', async () => {
    let finalHostFetched = 0;
    mswServer.use(
      http.get('https://images.example.com/redir.png', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://cdn-internal.example.com/steal.png' },
        }),
      ),
      http.get('https://cdn-internal.example.com/steal.png', () => {
        finalHostFetched += 1;
        return new HttpResponse(Buffer.from('x'), { headers: { 'Content-Type': 'image/png' } });
      }),
    );

    // The redirect target is public-looking text but resolves to loopback —
    // the classic DNS-rebinding SSRF bypass.
    setDnsLookupForTesting(async (hostname) =>
      hostname === 'cdn-internal.example.com'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: PUBLIC_IP, family: 4 }],
    );

    await expect(fetchRemoteImage('https://images.example.com/redir.png')).rejects.toMatchObject({
      code: 'URL_REJECTED',
    });
    expect(finalHostFetched).toBe(0);
  });
});
