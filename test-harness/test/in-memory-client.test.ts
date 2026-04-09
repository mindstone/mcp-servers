import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createInMemoryTestClient, type McpTestClient } from '../src/index.js';

/**
 * Creates a minimal MCP server with a single echo tool for testing.
 * Reads MY_VAR from process.env to verify env stubbing works.
 */
function createTestServer(): McpServer {
  const server = new McpServer({
    name: 'test-server',
    version: '1.0.0',
  });

  server.registerTool(
    'echo',
    {
      description: 'Echo back the input with env info',
      inputSchema: z.object({
        message: z.string().describe('Message to echo'),
      }),
    },
    async (args) => {
      const envValue = process.env.MY_VAR ?? 'not-set';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ echo: args.message, envValue }),
        }],
      };
    },
  );

  server.registerTool(
    'greet',
    {
      description: 'A greeting tool',
      inputSchema: z.object({
        name: z.string().describe('Name to greet'),
      }),
    },
    async (args) => ({
      content: [{
        type: 'text' as const,
        text: `Hello, ${args.name}!`,
      }],
    }),
  );

  return server;
}

describe('createInMemoryTestClient', () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
  });

  it('creates client-server pair and lists tools', async () => {
    testClient = await createInMemoryTestClient({
      createServer: createTestServer,
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    expect(toolsResult.tools).toHaveLength(2);
    expect(toolNames).toEqual(['echo', 'greet']);
  });

  it('callTool returns structured result with text and json', async () => {
    testClient = await createInMemoryTestClient({
      createServer: createTestServer,
    });

    const result = await testClient.callTool('echo', { message: 'hello' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.json).toEqual({ echo: 'hello', envValue: 'not-set' });
    expect(result.isError).toBeUndefined();
  });

  it('callTool returns text for non-JSON responses', async () => {
    testClient = await createInMemoryTestClient({
      createServer: createTestServer,
    });

    const result = await testClient.callTool('greet', { name: 'World' });

    expect(result.text).toBe('Hello, World!');
    expect(result.json).toBeNull();
  });

  it('stubs env vars before server creation (VAL-FOUND-005)', async () => {
    testClient = await createInMemoryTestClient({
      createServer: createTestServer,
      env: { MY_VAR: 'test-value-123' },
    });

    const result = await testClient.callTool('echo', { message: 'check-env' });

    expect(result.json).toEqual({
      echo: 'check-env',
      envValue: 'test-value-123',
    });
  });

  it('cleans up env stubs after close (VAL-FOUND-005)', async () => {
    const originalValue = process.env.MY_VAR;

    testClient = await createInMemoryTestClient({
      createServer: createTestServer,
      env: { MY_VAR: 'temporary-value' },
    });

    // Env should be stubbed while client is open
    expect(process.env.MY_VAR).toBe('temporary-value');

    await testClient.close();
    testClient = undefined;

    // Env should be restored after close
    expect(process.env.MY_VAR).toBe(originalValue);
  });
});
