import { describe, it, expect, afterAll } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';

describe('canary smoke', () => {
  let testClient: McpTestClient;

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('lists exactly one tool: ping', async () => {
    testClient = await createInMemoryTestClient({
      createServer,
    });
    const toolsResult = await testClient.client.listTools();
    expect(toolsResult.tools).toHaveLength(1);
    expect(toolsResult.tools[0].name).toBe('ping');
  });

  it('echoes pong v2: <message>', async () => {
    if (!testClient) {
      testClient = await createInMemoryTestClient({ createServer });
    }
    const result = await testClient.callTool('ping', { message: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe('pong v2: hello');
  });

  it('rejects empty message via Zod', async () => {
    if (!testClient) {
      testClient = await createInMemoryTestClient({ createServer });
    }
    const result = await testClient.callTool('ping', { message: '' });
    expect(result.isError).toBe(true);
  });

  it('rejects message over 200 chars via Zod', async () => {
    if (!testClient) {
      testClient = await createInMemoryTestClient({ createServer });
    }
    const longMsg = 'x'.repeat(201);
    const result = await testClient.callTool('ping', { message: longMsg });
    expect(result.isError).toBe(true);
  });
});
