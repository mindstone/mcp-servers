import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { vi } from 'vitest';

// CRITICAL: Do NOT add static imports from the connector source (e.g., createServer).
// auth.ts captures env vars at import time. We must set env BEFORE dynamic import.

export interface McpTestClient {
  client: Client;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

export interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  /** Convenience: extracted text from the first text content block */
  text: string;
  /** Convenience: parsed JSON from text (null if not valid JSON) */
  json: unknown | null;
}

export interface TestClientOptions {
  /** Environment variable overrides. Applied via vi.stubEnv before importing the connector. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to the Zendesk connector server.
 *
 * Uses dynamic imports to ensure auth.ts captures the stubbed env vars.
 * Call this AFTER setting up temp config dirs and MSW handlers.
 */
export async function createTestClient(options: TestClientOptions = {}): Promise<McpTestClient> {
  const env = options.env ?? {};

  // Stub environment variables before importing the connector
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  // Reset module registry so auth.ts re-evaluates with new env
  vi.resetModules();

  // Dynamic import: gets a fresh module with the stubbed env vars
  const { createServer } = await import('../../src/server.js');

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const callTool = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const firstText = content.find(c => c.type === 'text')?.text ?? '';
    let json: unknown | null = null;
    try {
      json = JSON.parse(firstText);
    } catch {
      // Not JSON — that's fine for concise format responses
    }
    return {
      content,
      isError: result.isError as boolean | undefined,
      text: firstText,
      json,
    };
  };

  const close = async () => {
    await client.close();
    await server.close();
  };

  return { client, callTool, close };
}
