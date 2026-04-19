import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('PandaDoc template tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('list_templates returns all templates', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_templates', {});
    const json = result.json as { ok: boolean; templates: Array<{ id: string; name: string }> };
    expect(json.ok).toBe(true);
    expect(json.templates).toHaveLength(2);
    expect(json.templates[0].id).toBe('tmpl-1');
  });

  it('list_templates with search query filters', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_templates', { q: 'NDA' });
    const json = result.json as { ok: boolean; templates: Array<{ id: string; name: string }> };
    expect(json.ok).toBe(true);
    expect(json.templates).toHaveLength(1);
    expect(json.templates[0].name).toBe('NDA Template');
  });
});
