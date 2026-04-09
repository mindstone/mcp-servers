import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 10 tools with correct names', async () => {
    mswServer.use(...createMixmaxHandlers());

    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: 'test-mixmax-token',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(10);
    expect(toolNames).toEqual([
      'add_mixmax_sequence_recipients',
      'configure_mixmax_api_key',
      'get_mixmax_sequence',
      'get_mixmax_user',
      'list_mixmax_meeting_types',
      'list_mixmax_messages',
      'list_mixmax_sequences',
      'list_mixmax_snippets',
      'send_mixmax_email',
      'send_mixmax_snippet',
    ]);
  });
});
