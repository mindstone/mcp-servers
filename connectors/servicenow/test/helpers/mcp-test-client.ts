import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

// Re-export shared types so test files can import from a single place.
export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  /** Environment variable overrides. Applied via vi.stubEnv before importing the connector. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to the ServiceNow connector server.
 *
 * Wraps the shared test-harness createInMemoryTestClient with ServiceNow-specific
 * module reset logic: vi.resetModules() + dynamic import ensures auth.ts
 * re-evaluates with the freshly stubbed env vars.
 */
export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = options.env ?? {};

  // Stub environment variables BEFORE resetting modules + dynamic import.
  // auth.ts captures env vars at import time.
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  // Reset module registry so auth.ts re-evaluates with new env
  vi.resetModules();

  // Dynamic import: gets a fresh module with the stubbed env vars
  const { createServer } = await import('../../src/server.js');

  // Pass empty env to shared client since we already stubbed env above.
  return createInMemoryTestClient({ createServer });
}
