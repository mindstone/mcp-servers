import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { http as mswHttp, passthrough } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';

// A real server, so fetch's own redirect handling runs: a stubbed 302 Response
// would fail the call without the fix and prove nothing.
let server: http.Server;
let base = '';
let originHits = 0;
let originSawKey = false;
let targetHits = 0;
let targetSawKey = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/target')) {
      targetHits++;
      if (req.headers['x-api-key']) targetSawKey = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ next_cursor: null, items: [] }));
      return;
    }
    originHits++;
    if (req.headers['x-api-key'] === API_KEY) originSawKey = true;
    res.writeHead(302, { location: `${base}/target` });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Fathom API redirects', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.doUnmock('../src/types.js');
    vi.unstubAllEnvs();
  });

  async function setup() {
    vi.doMock('../src/types.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/types.js')>()),
      FATHOM_API_BASE: base,
    }));
    mswServer.use(mswHttp.all(`${base}/*`, () => passthrough()));
    originHits = 0;
    originSawKey = false;
    targetHits = 0;
    targetSawKey = false;
    testClient = await createTestClient({ env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' } });
  }

  // The second case passes its own fetch options (method, body), which are spread before the redirect policy.
  it.each([
    ['list_fathom_meetings', {}],
    ['request_fathom_recording_download', { recording_id: 101 }],
  ])('%s refuses a redirect, so the API key never reaches the target', async (tool, args) => {
    await setup();

    const result = await testClient.callTool(tool, args);

    expect(result.isError).toBe(true);
    expect((result.json as { ok: boolean }).ok).toBe(false);
    expect(result.text).not.toContain(API_KEY);
    // The request did reach the API (with its key), so the failure is the refused redirect.
    expect(originHits).toBe(1);
    expect(originSawKey).toBe(true);
    expect(targetHits).toBe(0);
    expect(targetSawKey).toBe(false);
  });
});
