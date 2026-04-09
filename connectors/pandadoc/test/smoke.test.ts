import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 9 tools with correct names', async () => {
    mswServer.use(...createPandaDocHandlers());

    testClient = await createTestClient({
      env: {
        PANDADOC_API_KEY: 'test-pandadoc-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(9);
    expect(toolNames).toEqual([
      'configure_pandadoc_api_key',
      'create_document_from_template',
      'download_document',
      'get_document_details',
      'get_document_status',
      'list_documents',
      'list_templates',
      'send_document',
      'upload_document',
    ]);
  });
});
