import {
  createInMemoryTestClient,
  type McpTestClient,
  type CallToolResult,
} from '@mindstone/mcp-test-harness';
import { vi } from 'vitest';

// CRITICAL: Do NOT add static imports from the connector source (e.g., createServer).
// auth.ts captures env vars at import time. We must set env BEFORE dynamic import.

// Re-export shared types so existing test files keep working with the same import path.
export type { McpTestClient, CallToolResult };

export interface TestClientOptions {
  /** Environment variable overrides. Applied via vi.stubEnv before importing the connector. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to the Zendesk connector server.
 *
 * Wraps the shared test-harness createInMemoryTestClient with Zendesk-specific
 * module reset logic: vi.resetModules() + dynamic import ensures auth.ts
 * re-evaluates with the freshly stubbed env vars.
 *
 * Call this AFTER setting up temp config dirs and MSW handlers.
 */
export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = options.env ?? {};

  // Stub environment variables BEFORE resetting modules + dynamic import.
  // auth.ts captures env vars at import time, so they must be set first.
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  // Reset module registry so auth.ts re-evaluates with new env
  vi.resetModules();

  // Dynamic import: gets a fresh module with the stubbed env vars
  const { createServer } = await import('../../src/server.js');

  // Pass empty env to shared client since we already stubbed env above.
  // The shared client would call vi.stubEnv again which is harmless but unnecessary.
  return createInMemoryTestClient({ createServer });
}
