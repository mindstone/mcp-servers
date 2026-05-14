import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  env?: Record<string, string>;
}

export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = options.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const { createServer } = await import('../../src/server.js');
  return createInMemoryTestClient({ createServer });
}
