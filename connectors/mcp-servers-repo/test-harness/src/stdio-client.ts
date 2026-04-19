import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpTestClient, CallToolResult } from './in-memory-client.js';

export interface StdioTestClientOptions {
  /** Command to spawn (e.g., `'node'`). */
  command: string;
  /** Arguments for the command (e.g., `['dist/index.js']`). */
  args: string[];
  /** Environment variables for the spawned process. Merged with current process env. */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
}

/**
 * Creates an MCP test client that communicates with a connector via spawned stdio.
 *
 * Spawns the connector as a child process and connects to it via StdioClientTransport.
 * Verifies the built artifact starts correctly and can handle MCP protocol requests.
 *
 * @param options - Spawn configuration.
 * @returns The same `McpTestClient` interface as `createInMemoryTestClient`.
 * @throws Error with actionable message if the binary is missing.
 */
export async function createStdioTestClient(options: StdioTestClientOptions): Promise<McpTestClient> {
  const { command, args, env = {}, cwd } = options;

  // Validate that the target file exists for common patterns
  if (command === 'node' && args.length > 0) {
    const targetPath = cwd
      ? (await import('node:path')).resolve(cwd, args[0])
      : (await import('node:path')).resolve(args[0]);

    const fs = await import('node:fs');
    if (!fs.existsSync(targetPath)) {
      throw new Error(
        `Cannot start stdio test client: file not found at "${targetPath}". ` +
        `Did you run "npm run build" first?`,
      );
    }
  }

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
    cwd,
  });

  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  await client.connect(transport);

  const callTool = async (name: string, toolArgs: Record<string, unknown>): Promise<CallToolResult> => {
    const result = await client.callTool({ name, arguments: toolArgs });
    const content = result.content as Array<{ type: string; text?: string }>;
    const firstText = content.find(c => c.type === 'text')?.text ?? '';
    let json: unknown | null = null;
    try {
      json = JSON.parse(firstText);
    } catch {
      // Not JSON — fine
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
  };

  return { client, callTool, close };
}
