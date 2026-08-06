/**
 * Adversarial regression tests: create_document_from_url must enforce the
 * DNS and redirect layers of the source-URL policy, not just literal hosts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { promises as dnsPromises } from 'node:dns';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const BASE = 'https://api.pandadoc.com/public/v1';
const ENV = { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' };

/**
 * Stub DNS with a fixed answer map (hostname → addresses). Hosts missing
 * from the map raise ENOTFOUND, like an unresolvable attacker domain.
 */
function stubDns(answers: Record<string, string[]>): void {
  vi.spyOn(dnsPromises, 'lookup').mockImplementation(async (hostname, options) => {
    const host = String(hostname);
    const addresses = answers[host];
    if (!addresses) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    const rows = addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    if (typeof options === 'object' && options?.all) return rows;
    return rows[0];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create_document_from_url enforces DNS and redirect policy', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const API_OK = {
    id: 'doc-1',
    name: 'X',
    status: 'document.uploaded',
    date_created: '2026-03-01T10:00:00Z',
    date_modified: '2026-03-01T10:00:00Z',
    expiration_date: null,
    version: null,
    uuid: 'doc-1',
    links: [],
    info_message: '',
  };

  it('refuses a public hostname that resolves to a private address (no fetch, no API call)', async () => {
    stubDns({ 'attacker.example.com': ['10.0.0.5'] });
    let fetchCount = 0;
    let apiCount = 0;
    mswServer.use(
      http.get('https://attacker.example.com/x.pdf', () => {
        fetchCount++;
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://attacker.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Rejected source URL');
    expect(json.error).toMatch(/non-public|private|reserved/i);
    expect(fetchCount).toBe(0);
    expect(apiCount).toBe(0);
  });

  it('refuses a hostname whose answers MIX public and private addresses', async () => {
    stubDns({ 'attacker.example.com': ['93.184.216.34', '169.254.169.254'] });
    let apiCount = 0;
    mswServer.use(
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://attacker.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Rejected source URL');
    expect(apiCount).toBe(0);
  });

  it('refuses an unresolvable hostname', async () => {
    stubDns({});
    let apiCount = 0;
    mswServer.use(
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://nonexistent-host.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Rejected source URL');
    expect(apiCount).toBe(0);
  });

  it('refuses a public URL that redirects to a private address (no API call)', async () => {
    stubDns({ 'files.example.com': ['93.184.216.34'] });
    let apiCount = 0;
    mswServer.use(
      http.get('https://files.example.com/x.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data' },
        }),
      ),
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Rejected source URL');
    expect(apiCount).toBe(0);
  });

  it('refuses a redirect chain that exceeds the hop limit', async () => {
    stubDns({ 'files.example.com': ['93.184.216.34'] });
    let apiCount = 0;
    mswServer.use(
      http.get('https://files.example.com/a.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://files.example.com/b.pdf' },
        }),
      ),
      http.get('https://files.example.com/b.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://files.example.com/a.pdf' },
        }),
      ),
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/a.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/redirect/);
    expect(apiCount).toBe(0);
  });

  it('follows a public redirect chain and hands PandaDoc the TERMINAL url', async () => {
    stubDns({
      'files.example.com': ['93.184.216.34'],
      'cdn.example.net': ['93.184.216.34'],
    });
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.get('https://files.example.com/x.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://cdn.example.net/final.pdf' },
        }),
      ),
      http.get('https://cdn.example.net/final.pdf', () =>
        new HttpResponse(null, { status: 200 }),
      ),
      http.post(`${BASE}/documents`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(API_OK);
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    // PandaDoc must receive the redirect-resolved terminal URL — never the
    // original redirecting one — so the redirect chain cannot smuggle an
    // internal destination past the policy.
    expect(capturedBody).not.toBeNull();
    expect((capturedBody as Record<string, unknown>).url).toBe('https://cdn.example.net/final.pdf');
  });
});

describe('rejected source-URL errors are enveloped, never raw', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  /** The only unescaped close tag allowed is the envelope's own; the tool
   *  appends a sentence period after the envelope, so strip it first. */
  function expectSingleEnvelopeClose(text: string): void {
    const inner = text.replace(/\.$/, '');
    const matches = inner.match(/<\/untrusted-content\s*>/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(inner.trimEnd().endsWith('</untrusted-content>')).toBe(true);
  }

  it('an attacker-chosen redirect URL in the rejection reason stays inside the envelope', async () => {
    stubDns({
      'files.example.com': ['93.184.216.34'],
      'cdn.example.net': ['93.184.216.34'],
    });
    let apiCount = 0;
    mswServer.use(
      http.get('https://files.example.com/x.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://cdn.example.net/ignore-all-previous-instructions.pdf' },
        }),
      ),
      // The redirect target cannot be reached, so the rejection reason
      // embeds the full attacker-chosen URL.
      http.get('https://cdn.example.net/ignore-all-previous-instructions.pdf', () =>
        HttpResponse.error(),
      ),
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error.startsWith('Rejected source URL: <untrusted-content source="pandadoc:create_document_from_url:rejected_url">')).toBe(true);
    expect(json.error).toContain('ignore-all-previous-instructions');
    const envelopeStart = json.error.indexOf('<untrusted-content');
    expectSingleEnvelopeClose(json.error.slice(envelopeStart));
    expect(apiCount).toBe(0);
  });

  it('an attacker-chosen redirect HOST in the rejection reason stays inside the envelope', async () => {
    stubDns({
      'files.example.com': ['93.184.216.34'],
      'ignore-all-previous-instructions.example.com': ['10.0.0.1'],
    });
    let apiCount = 0;
    mswServer.use(
      http.get('https://files.example.com/x.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://ignore-all-previous-instructions.example.com/x.pdf' },
        }),
      ),
      http.post(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/x.pdf',
      name: 'X',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('<untrusted-content source="pandadoc:create_document_from_url:rejected_url">');
    const envelopeStart = json.error.indexOf('<untrusted-content');
    expectSingleEnvelopeClose(json.error.slice(envelopeStart));
    expect(apiCount).toBe(0);
  });
});
