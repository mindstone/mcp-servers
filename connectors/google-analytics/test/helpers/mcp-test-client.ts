import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  /** Environment variable overrides applied via vi.stubEnv before importing the connector. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to the GA connector server.
 *
 * Mirrors the Fathom helper: stub env vars first, reset modules, then
 * dynamic-import server.ts so auth.ts captures the new env.
 */
export async function createTestClient(
  options: TestClientOptions = {},
): Promise<McpTestClient> {
  const env = options.env ?? {};

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  vi.resetModules();

  const { createServer } = await import('../../src/server.js');

  return createInMemoryTestClient({ createServer });
}
