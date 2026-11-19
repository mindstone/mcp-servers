import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { mockVideoId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { INVALID_CALLBACK_URL_MESSAGE, allowedCallbackUrl, isAllowedCallbackUrl } from '../src/utils.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';
const BASE = 'https://api-singapore.klingai.com/v1';

const EXPECTED_MESSAGE =
  "callback_url must be a complete HTTPS URL without a username or password. Use another webhook URL, or omit callback_url and check the task's status instead.";

/** Refused callback URLs; each holds a marker that must never be echoed back. */
const REFUSED: Array<[string, string]> = [
  ['plain http', 'http://hooks.example.com/MARKER-http'],
  ['username and password', 'https://jane:MARKER-pass@hooks.example.com/hook'],
  ['username only', 'https://MARKER-user@hooks.example.com/hook'],
  ['password only', 'https://:MARKER-pwonly@hooks.example.com/hook'],
  ['unparsable', 'not a url MARKER-unparsable'],
  ['scheme-relative', '//hooks.example.com/MARKER-relative'],
  ['percent-encoded @ in the username', 'https://user%40MARKER-pct:pw@hooks.example.com/hook'],
  ['percent-encoded @ in a username only', 'https://user%40MARKER-pctonly@hooks.example.com/hook'],
  ['backslashes with credentials', 'https:\\\\jane:MARKER-bspass@hooks.example.com\\hook'],
  ['empty string', ''],
];

/** Ordinary webhook URLs, tokens in the path or query included, stay accepted. */
const ACCEPTED: Array<[string, string]> = [
  ['port', 'https://hooks.example.com:8443/kling'],
  ['path token', 'https://hooks.example.com/hooks/T0KEN-in-path/kling'],
  ['query token', 'https://hooks.example.com/kling?token=abc123&source=kling'],
];

/**
 * Inputs another parser might read differently: each is accepted only in its
 * WHATWG-normalised form, and that form is what reaches Kling.
 */
const NORMALISED: Array<[string, string, string]> = [
  ['uppercase scheme and host', 'HTTPS://Hooks.Example.com/Kling', 'https://hooks.example.com/Kling'],
  ['surrounding whitespace', '  https://hooks.example.com/kling\t\n', 'https://hooks.example.com/kling'],
  ['IDN hostname', 'https://bücher.example/hook', 'https://xn--bcher-kva.example/hook'],
  ['https:/\\host', 'https:/\\hooks.example.com/kling', 'https://hooks.example.com/kling'],
  ['backslashes', 'https:\\\\hooks.example.com\\kling', 'https://hooks.example.com/kling'],
];

describe('isAllowedCallbackUrl', () => {
  it.each(REFUSED)('refuses %s', (_label, url) => {
    expect(isAllowedCallbackUrl(url)).toBe(false);
  });

  it.each(ACCEPTED)('accepts https with a %s', (_label, url) => {
    expect(isAllowedCallbackUrl(url)).toBe(true);
  });

  it.each(REFUSED)('gives no normalised form for %s', (_label, url) => {
    expect(allowedCallbackUrl(url)).toBeUndefined();
  });

  it.each(NORMALISED)('accepts %s in normalised form', (_label, url, normalised) => {
    expect(isAllowedCallbackUrl(url)).toBe(true);
    expect(allowedCallbackUrl(url)).toBe(normalised);
  });

  it('uses the fixed refusal wording', () => {
    expect(INVALID_CALLBACK_URL_MESSAGE).toBe(EXPECTED_MESSAGE);
  });
});

/** Every tool that takes callback_url, with the minimum other arguments it needs. */
const TOOLS: Array<{ tool: string; path: string; args: Record<string, unknown> }> = [
  { tool: 'generate_kling_image', path: '/images/generations', args: { prompt: 'A ceramic mug' } },
  { tool: 'generate_kling_video', path: '/videos/text2video', args: { prompt: 'timelapse' } },
  {
    tool: 'generate_kling_image_to_video',
    path: '/videos/image2video',
    args: { image_url: 'https://example.com/photo.jpg', prompt: 'zoom in' },
  },
  {
    tool: 'generate_kling_lip_sync',
    path: '/videos/lip-sync',
    args: {
      video_id: mockVideoId,
      mode: 'text2video',
      text: 'Welcome back',
      voice_id: 'oversea_male1',
      voice_language: 'en',
    },
  },
  { tool: 'extend_kling_video', path: '/videos/video-extend', args: { video_id: mockVideoId } },
];

describe.each(TOOLS)('$tool callback_url', ({ tool, path, args }) => {
  let testClient: McpTestClient;
  let requests: Array<Record<string, unknown>>;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function start(): Promise<void> {
    requests = [];
    mswServer.use(
      http.post(`${BASE}${path}`, async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: 'task-cb-1' } });
      }),
    );
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  it.each(REFUSED)('refuses %s without calling Kling or echoing the URL', async (_label, url) => {
    await start();
    const result = await testClient.callTool(tool, { ...args, callback_url: url });
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_URL');
    expect(json.error).toBe(EXPECTED_MESSAGE);
    expect(result.text).not.toContain('MARKER');
    expect(requests).toHaveLength(0);
  });

  it.each(NORMALISED)('forwards %s in its normalised form', async (_label, url, normalised) => {
    await start();
    const result = await testClient.callTool(tool, { ...args, callback_url: url });
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.callback_url).toBe(normalised);
  });

  it('forwards an https URL with port, path token and query token unchanged', async () => {
    await start();
    const url = 'https://hooks.example.com:8443/hooks/T0KEN/kling?token=abc123';
    const result = await testClient.callTool(tool, { ...args, callback_url: url });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.callback_url).toBe(url);
  });
});
