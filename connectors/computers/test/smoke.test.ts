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

  it('asks the person first before costly or irreversible steps', async () => {
    testClient ??= await createInMemoryTestClient({ createServer: () => createServer({}), env: {} });
    const { tools } = await testClient.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const create = byName.get('computer_create');
    expect(create?.annotations?.destructiveHint).toBe(true);
    expect(create?.description).toContain('Only after the person explicitly asks for a computer or agrees to one');
    const asks: Array<[string, string]> = [
      ['computer_run', 'ASK FIRST: before a destructive or irreversible command'],
      ['computer_job', 'check with them before cancelling work they are waiting for'],
      ['computer_browser', 'ASK FIRST: before submitting a form, sending a message or uploading a file, changing an account, making a purchase or deleting data'],
      ['computer_browser', 'Routine browsing and searches do not need another confirmation.'],
      ['computer_copy_in', 'check with the person first unless they asked for it'],
      ['computer_save_tool', 'check with the person before replacing one they did not ask you to change'],
      ['computer_use_tool', 'ASK FIRST: if the tool deletes, overwrites or changes something'],
      ['computer_stop', 'If commands are still running and the person has not already asked to stop this computer or its work, explain that stopping will end those commands and ask first.'],
    ];
    for (const [name, wording] of asks) expect(byName.get(name)?.description, name).toContain(wording);
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
