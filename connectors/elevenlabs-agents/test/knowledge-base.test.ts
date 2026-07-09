import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { OVERSIZED_KB_PADDING } from './fixtures/elevenlabs-agents-data.js';

describe('knowledge-base tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists documents and truncates large document content on get', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_knowledge_base_docs', { page_size: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.count).toBe(1);
    expect(listed.json.next_cursor).toBe('cursor_docs_2');
    expect(listed.json.documents[0].documentation_id).toBe('doc_test_123');
    expect(listed.json.documents[0].id).toBeUndefined();
    expect(listed.json.documents[0].type).toBe('text');

    const single = await testClient.callTool('get_knowledge_base_doc', {
      documentation_id: listed.json.documents[0].documentation_id,
    });
    expect(single.isError).toBeFalsy();
    expect(single.json.document.documentation_id).toBe('doc_test_123');
    expect(single.json.document.content_truncated).toBe(true);
    expect(single.json.document.content_original_bytes).toBeGreaterThan(50_000);
    expect(single.json.document.content_returned_bytes).toBeLessThanOrEqual(50_000);
    expect(Buffer.byteLength(OVERSIZED_KB_PADDING, 'utf8')).toBeGreaterThan(50_000);
  });
});
