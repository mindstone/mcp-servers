import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';

const EXPECTED_TOOLS = [
  'configure_opus_api_key',
  'opus_add_clip_to_collection',
  'opus_cancel_scheduled_post',
  'opus_create_censor_job',
  'opus_create_collection',
  'opus_create_project',
  'opus_create_social_copy_job',
  'opus_delete_collection',
  'opus_download_clip',
  'opus_export_collection',
  'opus_get_brand_templates',
  'opus_get_censor_job_status',
  'opus_get_clips',
  'opus_get_collections',
  'opus_get_project',
  'opus_get_social_accounts',
  'opus_get_social_copy_job',
  'opus_publish_post',
  'opus_remove_clip_from_collection',
  'opus_schedule_post',
  'opus_share_project',
  'opus_upload_video',
];

async function freshClient(env: Record<string, string> = {}): Promise<McpTestClient> {
  for (const [k, v] of Object.entries({ MCP_HOST_BRIDGE_STATE: '', ...env })) {
    vi.stubEnv(k, v);
  }
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  return createInMemoryTestClient({ createServer });
}

describe('Smoke test — Opus connector', () => {
  let testClient: McpTestClient | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 22 tools with the expected names', async () => {
    testClient = await freshClient({ OPUS_API_KEY: 'mock-opus-key' });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolNames).toEqual(EXPECTED_TOOLS);
    expect(toolsResult.tools).toHaveLength(EXPECTED_TOOLS.length);
  });

  it('returns AUTH_REQUIRED when no API key is configured', async () => {
    testClient = await freshClient({ OPUS_API_KEY: '' });
    const result = await testClient.callTool('opus_get_brand_templates', { q: 'mine' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Opus API key not configured');
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 22 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        OPUS_API_KEY: 'mcp-test-opus-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(22);
    } finally {
      await client.close();
    }
  });
});
