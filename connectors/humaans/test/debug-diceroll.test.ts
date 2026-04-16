import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('DEBUG diceroll', () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('debug', async () => {
    mswServer.use(...createHumaansHandlers(API_KEY));
    testClient = await createTestClient({ env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' } });
    const result = await testClient.callTool('diceroll_humaans_person', {});
    console.log('isError:', result.isError);
    console.log('text:', JSON.stringify(result.text));
    console.log('json:', result.json);
    expect(result.json).toBeTruthy();
  });
});
