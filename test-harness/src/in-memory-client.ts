import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vi } from 'vitest';

/**
 * Result from calling an MCP tool via the test client.
 */
export interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  /** Convenience: extracted text from the first text content block */
  text: string;
  /** Convenience: parsed JSON from text (null if not valid JSON) */
  json: unknown | null;
}

/**
 * Test client connected to an MCP server via InMemoryTransport.
 */
export interface McpTestClient {
  client: Client;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

export interface InMemoryTestClientOptions {
  /** Function that creates the MCP server to test. Dynamically imported after env stubs are applied. */
  createServer: () => McpServer;
  /** Environment variable overrides. Applied via vi.stubEnv before creating the server. */
  env?: Record<string, string>;
}

/**
 * Creates a fresh MCP test client connected to a connector server via InMemoryTransport.
 *
 * Stubs environment variables before creating the server so that modules
 * which capture env at import time see the correct values.
 * Call this AFTER setting up temp config dirs and MSW handlers.
 */
export async function createInMemoryTestClient(options: InMemoryTestClientOptions): Promise<McpTestClient> {
  const { createServer, env = {} } = options;

  // Stub environment variables before creating the server
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  let server: ReturnType<typeof createServer>;
  let client: Client;

  try {
    server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  } catch (error) {
    // Clean up env stubs on initialization failure to prevent leaks
    vi.unstubAllEnvs();
    throw error;
  }

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
    vi.unstubAllEnvs();
  };

  return { client, callTool, close };
}
