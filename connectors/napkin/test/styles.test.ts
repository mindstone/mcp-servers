import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('napkin_list_styles', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns the 15 built-in styles with ids, descriptions, and categories', async () => {
    testClient = await createTestClient({
      env: { NAPKIN_API_KEY: 'mcp-test-napkin-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('napkin_list_styles', {});

    expect(result.isError).toBeFalsy();
    const data = result.json as {
      styles: Array<{ id: string; name: string; description: string; category: string }>;
      docs_url: string;
      message: string;
    };
    expect(data.styles).toHaveLength(15);
    for (const style of data.styles) {
      expect(style.id).toBeTruthy();
      expect(style.name).toBeTruthy();
      expect(style.description).toBeTruthy();
      expect(style.category).toBeTruthy();
    }
    expect(data.docs_url).toContain('napkin.ai');
    expect(data.message).toContain('style_id');
  });

  it('includes all style categories from the vendor docs', async () => {
    testClient = await createTestClient({
      env: { NAPKIN_API_KEY: 'mcp-test-napkin-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('napkin_list_styles', {});

    const data = result.json as { styles: Array<{ category: string }> };
    const categories = [...new Set(data.styles.map((s) => s.category))].sort();
    expect(categories).toEqual(['casual', 'colorful', 'formal', 'hand-drawn', 'monochrome']);
  });

  it('works without an API key and makes no network call', async () => {
    // No NAPKIN_API_KEY configured; any outbound fetch would fail the test
    // because the shared MSW server errors on unhandled requests.
    testClient = await createTestClient({
      env: { NAPKIN_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('napkin_list_styles', {});

    expect(result.isError).toBeFalsy();
    const data = result.json as { styles: unknown[] };
    expect(data.styles).toHaveLength(15);
  });
});
