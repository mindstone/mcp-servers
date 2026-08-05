import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createStdioTestClient, type McpTestClient as StdioMcpTestClient } from '@mindstone/mcp-test-harness';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 13 tools with correct names', async () => {
    mswServer.use(...createMixmaxHandlers());

    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: 'test-mixmax-token',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(13);
    expect(toolNames).toEqual([
      'add_mixmax_sequence_recipients',
      'cancel_mixmax_message',
      'configure_mixmax_api_key',
      'get_mixmax_report',
      'get_mixmax_sequence',
      'get_mixmax_user',
      'list_mixmax_meeting_types',
      'list_mixmax_messages',
      'list_mixmax_sequences',
      'list_mixmax_snippets',
      'remove_mixmax_sequence_recipients',
      'send_mixmax_email',
      'send_mixmax_snippet',
    ]);
  });
});

describe('Smoke test — spawned stdio', () => {
  const distPath = resolve(import.meta.dirname, '..', 'dist', 'index.js');
  let stdioClient: StdioMcpTestClient;

  afterAll(async () => {
    if (stdioClient) await stdioClient.close();
  });

  it('spawned dist/index.js lists exactly 13 tools', async () => {
    // Verify built artifact exists
    expect(existsSync(distPath)).toBe(true);

    stdioClient = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        MIXMAX_API_TOKEN: 'test-stdio-token',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await stdioClient.client.listTools();
    expect(toolsResult.tools).toHaveLength(13);

    const toolNames = toolsResult.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'add_mixmax_sequence_recipients',
      'cancel_mixmax_message',
      'configure_mixmax_api_key',
      'get_mixmax_report',
      'get_mixmax_sequence',
      'get_mixmax_user',
      'list_mixmax_meeting_types',
      'list_mixmax_messages',
      'list_mixmax_sequences',
      'list_mixmax_snippets',
      'remove_mixmax_sequence_recipients',
      'send_mixmax_email',
      'send_mixmax_snippet',
    ]);
  });
});
