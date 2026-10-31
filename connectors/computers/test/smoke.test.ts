import { describe, it, expect, afterAll } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';

describe('Computers connector', () => {
  let testClient: McpTestClient;
  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('lists every tool, each with annotations and a when-to-use description', async () => {
    testClient = await createInMemoryTestClient({ createServer: () => createServer({}), env: {} });
    const { tools } = await testClient.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'computer_browser',
      'computer_check_setup',
      'computer_copy_in',
      'computer_copy_out',
      'computer_create',
      'computer_job',
      'computer_list',
      'computer_remove',
      'computer_run',
      'computer_save_tool',
      'computer_setup',
      'computer_stop',
      'computer_tools',
      'computer_use_tool',
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(120);
    }
  });

  it('says how to connect an account when none is set up', async () => {
    testClient ??= await createInMemoryTestClient({ createServer: () => createServer({}), env: {} });
    const result = await testClient.client.callTool({ name: 'computer_list', arguments: {} });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(body.resolution).toMatch(/Fly\.io API token, an E2B API key or a Google Cloud service-account key/);
  });
});
