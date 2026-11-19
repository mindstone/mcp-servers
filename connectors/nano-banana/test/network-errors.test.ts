/**
 * Network failures never put their raw text (which can quote the request URL,
 * and so the API key) into a tool result, and Gemini response schemas drop
 * fields the connector does not read.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_IMAGE_BASE64, createMockGeminiResponse } from './fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const API_KEY = 'AIzaFakeCanaryKey-network-0123';
const SENTINEL = 'SENTINEL-network-secret-9e3b';
const REMOTE_URL = 'https://images.example.com/pic.png';

const NETWORK_RESULT = {
  ok: false,
  error: 'Could not get a complete response from Gemini.',
  code: 'NETWORK_ERROR',
  resolution: 'Check your internet connection, then try again.',
};
const REMOTE_RESULT = {
  ok: false,
  error: 'Could not download the source image.',
  code: 'REMOTE_IMAGE_FETCH_FAILED',
  resolution:
    'Check that the link opens a PNG, JPEG or WebP image, or download it into the workspace and use the local file.',
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('Network failures give fixed text', () => {
  let testClient: McpTestClient | undefined;
  let workspaceDir: string;
  let stderrSpy: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-network-')));
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function client(): Promise<McpTestClient> {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspaceDir },
    });
    const { setDnsLookupForTesting } = await import('../src/tools/remote-image.js');
    setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
    return testClient;
  }

  /** Make every fetch to a URL starting with `prefix` fail as `fail` does. */
  function failFetch(prefix: string, fail: (url: string) => Promise<Response>) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      return url.startsWith(prefix) ? fail(url) : realFetch(input, init);
    });
  }

  /** A rejection quoting the request URL (and so the key) plus a sentinel. */
  const rejectQuotingUrl = (url: string) =>
    Promise.reject(new TypeError(`fetch failed: ${url} ${SENTINEL} ${API_KEY}`));

  function expectClean(result: { text: string }) {
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).not.toContain(API_KEY);
  }

  /** The raw failure reached stderr (the sentinel proves it), with the key removed. */
  function expectStderrRedacted() {
    const lines = stderrSpy.mock.calls.map((args) => args.join(' '));
    expect(lines.some((l) => l.includes(SENTINEL))).toBe(true);
    expect(lines.some((l) => l.includes(API_KEY))).toBe(false);
  }

  it('nano_banana_generate: a rejected Gemini request', async () => {
    const c = await client();
    failFetch(GEMINI_API_BASE, rejectQuotingUrl);
    const result = await c.callTool('nano_banana_generate', { prompt: 'a cat' });
    expect(result.isError).toBe(true);
    expectClean(result);
    expect(result.json).toEqual(NETWORK_RESULT);
  });

  it('nano_banana_edit: a rejected Gemini request', async () => {
    const c = await client();
    const local = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(local, Buffer.from(MOCK_IMAGE_BASE64, 'base64'));
    failFetch(GEMINI_API_BASE, rejectQuotingUrl);
    const result = await c.callTool('nano_banana_edit', { source_image_path: local, prompt: 'rotate' });
    expect(result.isError).toBe(true);
    expectClean(result);
    expect(result.json).toEqual(NETWORK_RESULT);
  });

  it('the raw failure goes to stderr with the key removed', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client();
    failFetch(GEMINI_API_BASE, rejectQuotingUrl);
    await c.callTool('nano_banana_generate', { prompt: 'a cat' });
    const lines = stderr.mock.calls.map((args) => args.join(' '));
    expect(lines.some((l) => l.includes(SENTINEL))).toBe(true);
    expect(lines.some((l) => l.includes(API_KEY))).toBe(false);
  });

  it('nano_banana_edit: a rejected remote source image request', async () => {
    let geminiCalls = 0;
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () => {
        geminiCalls++;
        return HttpResponse.json(createMockGeminiResponse());
      }),
    );
    const c = await client();
    failFetch(REMOTE_URL, rejectQuotingUrl);
    const result = await c.callTool('nano_banana_edit', { source_image_path: REMOTE_URL, prompt: 'rotate' });
    expect(result.isError).toBe(true);
    expectClean(result);
    expect(result.json).toEqual(REMOTE_RESULT);
    expect(geminiCalls).toBe(0);
    expectStderrRedacted();
  });

  it('nano_banana_edit: a remote source image whose download breaks mid-body', async () => {
    const c = await client();
    failFetch(REMOTE_URL, async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x89, 0x50]));
          controller.error(new TypeError(`terminated: other side closed ${SENTINEL} ${API_KEY}`));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'image/png' } });
    });
    const result = await c.callTool('nano_banana_edit', { source_image_path: REMOTE_URL, prompt: 'rotate' });
    expect(result.isError).toBe(true);
    expectClean(result);
    expect(result.json).toEqual(REMOTE_RESULT);
    expectStderrRedacted();
  });

  it('an HTTP error body echoing the key never reaches the result', async () => {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, ({ request }) =>
        HttpResponse.json(
          { error: { message: `Bad request for ${request.url} key=${API_KEY} ${SENTINEL}` } },
          { status: 400 },
        ),
      ),
    );
    const c = await client();
    const result = await c.callTool('nano_banana_generate', { prompt: 'a cat' });
    expect(result.isError).toBe(true);
    expectClean(result);
    expect((result.json as { code: string }).code).toBe('HTTP_400');
  });
});

describe('withErrorHandling: unknown errors', () => {
  it('returns fixed text, never the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { withErrorHandling } = await import('../src/utils.js');
    const handler = withErrorHandling(async () => {
      throw new Error(`boom ${SENTINEL} ${API_KEY}`);
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(API_KEY);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: 'The Nano Banana connector hit an unexpected error.',
      code: 'UNEXPECTED_ERROR',
      resolution: 'Try again. If it keeps happening, restart the connector.',
    });
    vi.restoreAllMocks();
  });
});

describe('Gemini response schemas', () => {
  it('drop fields the connector does not read', async () => {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
        HttpResponse.json({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { data: MOCK_IMAGE_BASE64, mimeType: 'image/png', injected: SENTINEL }, extra: SENTINEL },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          promptFeedback: { blockReason: undefined, safetyRatings: [SENTINEL] },
          usageMetadata: { totalTokenCount: 10 },
          injected: SENTINEL,
        }),
      ),
    );
    const { geminiFetch } = await import('../src/client.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = await geminiFetch(API_KEY, 'gemini-3.1-flash-image-preview', {});
    expect(data).toEqual({
      candidates: [{ content: { parts: [{ inlineData: { data: MOCK_IMAGE_BASE64, mimeType: 'image/png' } }] } }],
      promptFeedback: {},
    });
    expect(JSON.stringify(data)).not.toContain(SENTINEL);
    vi.restoreAllMocks();
  });
});
