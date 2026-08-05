/**
 * Security tests — export download URL hardening
 *
 * Covers the `validateDownloadUrl` allow-list for PDF/PPTX export downloads:
 *  - Hard-coded Gamma host allow-list (gamma.app and subdomains).
 *  - HTTPS-only, userinfo rejection, private/loopback/reserved-IP rejection.
 *  - A rejected URL produces a structured URL_REJECTED error with ZERO
 *    outbound network calls to the offending host.
 *  - A poisoned status payload degrades gracefully inside gamma_get_status:
 *    the generation result is still returned, the download is skipped, and
 *    the rejection is surfaced in the message.
 *  - Existing happy-path export download behaviour is preserved (covered by
 *    the export polling tests in generation.test.ts, which use
 *    public-api.gamma.app URLs).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/gamma-data.js';
import { validateDownloadUrl, downloadExportFile } from '../src/client.js';
import { GammaError } from '../src/types.js';

const BASE = 'https://public-api.gamma.app/v1.0';

/** Credential-shaped marker built programmatically (never a literal). */
const VENDOR_BODY_MARKER = ['AC', '0123456789abcdef', '0123456789abcdef'].join('');

describe('validateDownloadUrl (unit)', () => {
  it.each([
    'https://gamma.app/export/abc123.pdf',
    'https://public-api.gamma.app/mock-exports/gen-1.pdf',
    'https://cdn.gamma.app/exports/gen-1.pptx',
  ])('accepts Gamma-hosted URL (%s)', (url) => {
    expect(validateDownloadUrl(url).toString()).toBe(url);
  });

  it.each([
    'http://public-api.gamma.app/exports/gen-1.pdf',
    'ftp://gamma.app/exports/gen-1.pdf',
    'file:///etc/passwd',
    'data:text/plain,hello',
  ])('rejects non-HTTPS scheme (%s)', (url) => {
    expect(() => validateDownloadUrl(url)).toThrowError(GammaError);
    try {
      validateDownloadUrl(url);
    } catch (error) {
      expect((error as GammaError).code).toBe('URL_REJECTED');
    }
  });

  it.each([
    'https://user:pass@public-api.gamma.app/exports/gen-1.pdf',
    'https://user@gamma.app/export/x.pdf',
  ])('rejects userinfo (%s)', (url) => {
    expect(() => validateDownloadUrl(url)).toThrowError(GammaError);
  });

  it.each([
    'https://127.0.0.1/x.pdf',
    'https://localhost/x.pdf',
    'https://10.0.0.5/x.pdf',
    'https://172.16.0.1/x.pdf',
    'https://192.168.1.1/x.pdf',
    'https://169.254.169.254/latest/meta-data/',
    'https://0.0.0.0/x.pdf',
    'https://[::1]/x.pdf',
  ])('rejects private/loopback/reserved host (%s)', (url) => {
    expect(() => validateDownloadUrl(url)).toThrowError(GammaError);
  });

  it.each([
    'https://attacker.example/exports/gen-1.pdf',
    'https://gamma.app.evil.example/x.pdf',
    'https://evilgamma.app/x.pdf',
    'https://notgamma.app/x.pdf',
  ])('rejects host outside the Gamma allow-list (%s)', (url) => {
    try {
      validateDownloadUrl(url);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GammaError);
      expect((error as GammaError).code).toBe('URL_REJECTED');
      expect((error as GammaError).message).toMatch(/allow-list/);
    }
  });

  it('rejects malformed URLs', () => {
    expect(() => validateDownloadUrl('not a url at all')).toThrowError(GammaError);
  });
});

describe('gamma_get_status — poisoned export URL handling', () => {
  let testClient: McpTestClient;
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    vi.unstubAllEnvs();
  });

  function fetchCallsTo(host: string): number {
    return (fetchSpy?.mock.calls ?? []).filter(([input]) => {
      try {
        const url =
          typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL((input as Request).url);
        return url.host === host;
      } catch {
        return false;
      }
    }).length;
  }

  it('refuses a non-Gamma export host with zero outbound calls to it', async () => {
    const genId = 'gen-evil-export';
    mswServer.use(
      http.post(`${BASE}/generations`, ({ request }) => {
        if (!request.headers.get('x-api-key'))
          return HttpResponse.json({}, { status: 401 });
        return HttpResponse.json({ generationId: genId });
      }),
      http.get(`${BASE}/generations/${genId}`, () =>
        HttpResponse.json({
          generationId: genId,
          status: 'completed',
          gammaUrl: 'https://gamma.app/docs/Test-Deck',
          pdfUrl: 'https://attacker.example/exports/steal.pdf',
        }),
      ),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const genResult = await testClient.callTool('gamma_generate', {
      input_text: 'test poisoned export',
      export_as: 'pdf',
    });
    expect(genResult.isError).toBeFalsy();

    fetchSpy?.mockClear();

    const statusResult = await testClient.callTool('gamma_get_status', {
      generation_id: genId,
    });

    // Graceful degradation: the completed generation is still returned, the
    // download is skipped, and the rejection is surfaced in the message.
    expect(statusResult.isError).toBeFalsy();
    const data = statusResult.json as {
      status: string;
      message: string;
      file_path?: string;
    };
    expect(data.status).toBe('completed');
    expect(data.file_path).toBeUndefined();
    expect(data.message).toContain('download failed');
    expect(data.message).toMatch(/allow-list/);

    // Crucial: zero fetch calls to the attacker host.
    expect(fetchCallsTo('attacker.example')).toBe(0);
  });

  it('refuses a private-IP export URL with zero outbound calls to it', async () => {
    const genId = 'gen-ssrf-export';
    mswServer.use(
      http.post(`${BASE}/generations`, ({ request }) => {
        if (!request.headers.get('x-api-key'))
          return HttpResponse.json({}, { status: 401 });
        return HttpResponse.json({ generationId: genId });
      }),
      http.get(`${BASE}/generations/${genId}`, () =>
        HttpResponse.json({
          generationId: genId,
          status: 'completed',
          pdfUrl: 'https://169.254.169.254/latest/meta-data/',
        }),
      ),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('gamma_generate', {
      input_text: 'test ssrf export',
      export_as: 'pdf',
    });

    fetchSpy?.mockClear();

    const statusResult = await testClient.callTool('gamma_get_status', {
      generation_id: genId,
    });

    expect(statusResult.isError).toBeFalsy();
    const data = statusResult.json as { message: string; file_path?: string };
    expect(data.file_path).toBeUndefined();
    expect(data.message).toMatch(/private\/loopback\/reserved/);
    expect(fetchCallsTo('169.254.169.254')).toBe(0);
  });
});

describe('Gamma API response validation (fail-closed Zod)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('surfaces a malformed JSON body as a generic INVALID_RESPONSE, without parser fragments', async () => {
    // V8 JSON.parse errors embed an excerpt of the source text; the marker
    // must not reach the model through that channel.
    mswServer.use(
      http.get(`${BASE}/generations/:id`, () =>
        new HttpResponse(`{"generationId":"gen-x","note":"${VENDOR_BODY_MARKER}", broken`, {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('gamma_get_status', {
      generation_id: 'gen-x',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('INVALID_RESPONSE');
    expect(result.text).not.toContain(VENDOR_BODY_MARKER);
  });

  it('rejects a well-formed body that fails schema validation', async () => {
    mswServer.use(
      http.get(`${BASE}/generations/:id`, () =>
        HttpResponse.json({ generationId: 'gen-x' }), // missing required `status`
      ),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('gamma_get_status', {
      generation_id: 'gen-x',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('INVALID_RESPONSE');
    expect(result.text).toContain('unexpected response shape');
  });

  it('keeps vendor error bodies out of the model-visible error AND the logs', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mswServer.use(
      http.get(`${BASE}/themes`, () =>
        HttpResponse.text(`gateway exploded: ${VENDOR_BODY_MARKER}`, { status: 500 }),
      ),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('gamma_list_themes', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('API_ERROR');
    expect(result.text).not.toContain(VENDOR_BODY_MARKER);
    const logged = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain(VENDOR_BODY_MARKER);
    consoleSpy.mockRestore();
  });

  it('reports unexpected (non-Gamma) errors generically, with detail only in logs', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mswServer.use(
      http.get(`${BASE}/themes`, () => HttpResponse.error()),
    );

    testClient = await createTestClient({
      env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('gamma_list_themes', {});

    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    // Generic message — the raw fetch error must not be relayed to the model.
    expect(parsed.error).toContain('unexpected error');
    // ...but the detail IS observable in the connector logs.
    const logged = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('[gamma] Unexpected tool error');
    consoleSpy.mockRestore();
  });
});

describe('downloadExportFile — redirect and temp-file safety', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  const writtenFiles: string[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    for (const f of writtenFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
    writtenFiles.length = 0;
  });

  function fetchCallsTo(host: string): number {
    return (fetchSpy?.mock.calls ?? []).filter(([input]) => {
      try {
        const url =
          typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL((input as Request).url);
        return url.host === host;
      } catch {
        return false;
      }
    }).length;
  }

  it('follows an in-allow-list redirect hop and downloads the file', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/redir.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: '/mock-exports/final.pdf' }, // relative Location
        }),
      ),
      http.get('https://public-api.gamma.app/mock-exports/final.pdf', () =>
        new HttpResponse(Buffer.from('redirected-pdf-bytes')),
      ),
    );

    const filePath = await downloadExportFile(
      'https://public-api.gamma.app/mock-exports/redir.pdf',
      'gen-redir',
      'pdf',
    );
    writtenFiles.push(filePath);

    expect(fs.readFileSync(filePath, 'utf8')).toBe('redirected-pdf-bytes');
  });

  it('refuses a redirect to an attacker host with zero outbound calls to it', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/bounce.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://attacker.example/steal.pdf' },
        }),
      ),
    );

    await expect(
      downloadExportFile('https://public-api.gamma.app/mock-exports/bounce.pdf', 'gen-bounce', 'pdf'),
    ).rejects.toMatchObject({ code: 'URL_REJECTED' });
    expect(fetchCallsTo('attacker.example')).toBe(0);
  });

  it('refuses a redirect to a private/link-local address (cloud metadata SSRF)', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/meta.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data/' },
        }),
      ),
    );

    await expect(
      downloadExportFile('https://public-api.gamma.app/mock-exports/meta.pdf', 'gen-meta', 'pdf'),
    ).rejects.toMatchObject({ code: 'URL_REJECTED' });
    expect(fetchCallsTo('169.254.169.254')).toBe(0);
  });

  it('refuses a redirect that downgrades to plaintext http', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/downgrade.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'http://public-api.gamma.app/mock-exports/final.pdf' },
        }),
      ),
    );

    await expect(
      downloadExportFile(
        'https://public-api.gamma.app/mock-exports/downgrade.pdf',
        'gen-downgrade',
        'pdf',
      ),
    ).rejects.toMatchObject({ code: 'URL_REJECTED' });
  });

  it('refuses a redirect chain that never terminates', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/loop.pdf', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://public-api.gamma.app/mock-exports/loop.pdf' },
        }),
      ),
    );

    await expect(
      downloadExportFile('https://public-api.gamma.app/mock-exports/loop.pdf', 'gen-loop', 'pdf'),
    ).rejects.toMatchObject({ code: 'URL_REJECTED', message: expect.stringMatching(/too many redirects/) });
  });

  it('writes the export as a fresh regular 0600 file inside the temp dir', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/unit.pdf', () =>
        new HttpResponse(Buffer.from('pdf-bytes')),
      ),
    );

    const filePath = await downloadExportFile(
      'https://public-api.gamma.app/mock-exports/unit.pdf',
      'gen-unit',
      'pdf',
    );
    writtenFiles.push(filePath);

    expect(filePath.startsWith(os.tmpdir())).toBe(true);
    const stat = fs.lstatSync(filePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('pdf-bytes');
  });

  it('gives every download a distinct, unpredictable temp path', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/uniq.pdf', () =>
        new HttpResponse(Buffer.from('x')),
      ),
    );

    const [a, b] = await Promise.all([
      downloadExportFile('https://public-api.gamma.app/mock-exports/uniq.pdf', 'gen-uniq', 'pdf'),
      downloadExportFile('https://public-api.gamma.app/mock-exports/uniq.pdf', 'gen-uniq', 'pdf'),
    ]);
    writtenFiles.push(a, b);
    expect(a).not.toBe(b);
  });

  it('leaves no partial file behind when the download response fails', async () => {
    mswServer.use(
      http.get('https://public-api.gamma.app/mock-exports/gone.pdf', () =>
        HttpResponse.text('gone', { status: 410 }),
      ),
    );

    await expect(
      downloadExportFile('https://public-api.gamma.app/mock-exports/gone.pdf', 'gen-gone', 'pdf'),
    ).rejects.toThrow(/HTTP 410/);

    const leftovers = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('gamma_export_gen-gone_'));
    expect(leftovers).toHaveLength(0);
  });
});
