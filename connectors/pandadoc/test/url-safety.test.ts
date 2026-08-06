/**
 * Unit tests for the resolution layer of the source-URL policy:
 * DNS-answer classification and redirect-chain handling, with injectable
 * DNS/fetch so every branch is deterministic (no network, no DNS).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolvePublicTerminalUrl,
  validatePublicHttpsUrl,
  type UrlResolutionDeps,
} from '../src/tools/url-safety.js';

const PUBLIC_IP = '93.184.216.34';
const PRIVATE_IP = '10.0.0.5';
const METADATA_IP = '169.254.169.254';

function deps(overrides: Partial<UrlResolutionDeps> = {}): UrlResolutionDeps {
  return {
    lookupAll: async () => [PUBLIC_IP],
    fetchImpl: async () => new Response(null, { status: 200 }),
    ...overrides,
  };
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

describe('validatePublicHttpsUrl (literal layer)', () => {
  it('accepts a public https URL', () => {
    expect(validatePublicHttpsUrl('https://files.example.com/x.pdf')).toBeNull();
  });

  it('rejects trailing-dot spellings of internal hostnames', () => {
    // `localhost.` is DNS-equivalent to `localhost`; the WHATWG parser keeps
    // the dot, so classification must strip it before comparing.
    expect(validatePublicHttpsUrl('https://localhost./internal.pdf')).not.toBeNull();
  });
});

describe('resolvePublicTerminalUrl — DNS layer', () => {
  it('refuses a hostname resolving to a private address, before any fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await resolvePublicTerminalUrl(
      'https://attacker.example.com/x.pdf',
      deps({ lookupAll: async () => [PRIVATE_IP], fetchImpl }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-public|private|reserved/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when ANY answer is non-public (mixed answers)', async () => {
    const result = await resolvePublicTerminalUrl(
      'https://attacker.example.com/x.pdf',
      deps({ lookupAll: async () => [PUBLIC_IP, METADATA_IP] }),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a hostname resolving to a link-local IPv6 answer', async () => {
    const result = await resolvePublicTerminalUrl(
      'https://attacker.example.com/x.pdf',
      deps({ lookupAll: async () => ['fe80::1'] }),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses an unresolvable hostname', async () => {
    const result = await resolvePublicTerminalUrl(
      'https://gone.example.com/x.pdf',
      deps({
        lookupAll: async () => {
          throw new Error('getaddrinfo ENOTFOUND gone.example.com');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be resolved/i);
  });

  it('refuses a hostname with zero DNS answers', async () => {
    const result = await resolvePublicTerminalUrl(
      'https://empty.example.com/x.pdf',
      deps({ lookupAll: async () => [] }),
    );
    expect(result.ok).toBe(false);
  });

  it('skips DNS for IP-literal hosts (literal layer already classified them)', async () => {
    const lookupAll = vi.fn(async () => [PRIVATE_IP]);
    const result = await resolvePublicTerminalUrl(
      'https://8.8.8.8/x.pdf',
      deps({ lookupAll }),
    );
    expect(result.ok).toBe(true);
    expect(lookupAll).not.toHaveBeenCalled();
  });
});

describe('resolvePublicTerminalUrl — redirect layer', () => {
  it('follows a public redirect chain and returns the terminal URL', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://files.example.com/a.pdf') {
        return redirectResponse('https://cdn.example.net/b.pdf');
      }
      return new Response(null, { status: 200 });
    };
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://cdn.example.net/b.pdf');
    expect(seen).toEqual([
      'https://files.example.com/a.pdf',
      'https://cdn.example.net/b.pdf',
    ]);
  });

  it('refuses a redirect to a private IP literal', async () => {
    const fetchImpl: typeof fetch = async () =>
      redirectResponse(`https://${METADATA_IP}/latest/meta-data`);
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a redirect downgraded to http', async () => {
    const fetchImpl: typeof fetch = async () => redirectResponse('http://files.example.com/b.pdf');
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/https/i);
  });

  it('re-validates DNS on every redirect hop', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://files.example.com/a.pdf') {
        return redirectResponse('https://attacker.example.com/b.pdf');
      }
      return new Response(null, { status: 200 });
    };
    const lookupAll: UrlResolutionDeps['lookupAll'] = async (hostname) =>
      hostname === 'attacker.example.com' ? [PRIVATE_IP] : [PUBLIC_IP];
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl, lookupAll }),
    );
    expect(result.ok).toBe(false);
  });

  it('resolves relative Location headers against the current URL', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://files.example.com/a.pdf') return redirectResponse('/b.pdf');
      return new Response(null, { status: 200 });
    };
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://files.example.com/b.pdf');
  });

  it('refuses a redirect chain beyond the hop limit', async () => {
    const fetchImpl: typeof fetch = async () => redirectResponse('https://files.example.com/loop.pdf');
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/loop.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/redirect/i);
  });

  it('refuses a redirect response without a Location header', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 302 });
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed when the verification fetch cannot complete', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('socket hang up');
    };
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be reached/i);
  });

  it('accepts a non-redirect error status as the terminal URL (availability is not the boundary)', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
    const result = await resolvePublicTerminalUrl(
      'https://files.example.com/a.pdf',
      deps({ fetchImpl }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://files.example.com/a.pdf');
  });
});
