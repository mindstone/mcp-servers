import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

// Re-export shared types so test files can import from this path.
export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  /** Environment variable overrides. Applied via vi.stubEnv before importing the connector. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to the Browser Automation connector server.
 *
 * Wraps the shared test-harness createInMemoryTestClient with module reset logic:
 * vi.resetModules() + dynamic import ensures browser-client.ts re-evaluates
 * with the freshly stubbed env vars.
 */
export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = options.env ?? {};

  // Stub environment variables BEFORE resetting modules + dynamic import.
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  // Reset module registry so browser-client.ts re-evaluates with new env
  vi.resetModules();

  // Dynamic import: gets a fresh module with the stubbed env vars
  const { createServer } = await import('../../src/server.js');

  return createInMemoryTestClient({ createServer });
}
