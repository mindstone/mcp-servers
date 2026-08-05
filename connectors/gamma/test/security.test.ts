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
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/gamma-data.js';
import { validateDownloadUrl } from '../src/client.js';
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
