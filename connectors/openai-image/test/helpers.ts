import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';

export const importConnectorModule = async (
  env: Record<string, string | undefined> = {},
) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('OPENAI_IMAGE_IMPORT_ONLY', '1');

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value ?? '');
  }

  return import('../src/index.js');
};

export const createInMemoryClientPair = async (server: McpServer) => {
  const client = new Client({
    name: 'openai-image-test-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

export const extractToolPayload = (result: CallToolResult): Record<string, unknown> => {
  const textContent = result.content.find(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  );

  if (!textContent) {
    throw new Error('Expected tool result to include text content.');
  }

  return JSON.parse(textContent.text) as Record<string, unknown>;
};
