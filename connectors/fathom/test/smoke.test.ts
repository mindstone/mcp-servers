import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 6 tools with correct names', async () => {
    mswServer.use(...createFathomHandlers());

    testClient = await createTestClient({
      env: {
        FATHOM_API_KEY: 'test-fathom-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(7);
    expect(toolNames).toEqual([
      'configure_fathom_api_key',
      'get_fathom_meeting',
      'get_fathom_meeting_participants',
      'get_fathom_transcript',
      'list_fathom_meetings',
      'list_fathom_team_members',
      'list_fathom_teams',
    ]);
  });
});
