import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling } from '../utils.js';

export function registerNavigationTools(server: McpServer): void {
  server.registerTool(
    'browser_navigate',
    {
      description: `Navigate to a URL. Opens the browser if not already running.

IMPORTANT: After navigating, call browser_snapshot to see the page content before interacting.`,
      inputSchema: {
        url: z.string().describe('URL to navigate to'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['open', args.url]);
      const titleResult = await execAgentBrowser(['get', 'title']).catch(() => ({ stdout: '', stderr: '' }));
      return JSON.stringify({
        ok: true,
        message: `Navigated to ${args.url}`,
        title: titleResult.stdout.trim(),
        hint: 'Call browser_snapshot to see page elements before interacting.',
      });
    }),
  );

  server.registerTool(
    'browser_back',
    {
      description: 'Navigate back in browser history.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      await execAgentBrowser(['back']);
      return JSON.stringify({ ok: true, message: 'Navigated back' });
    }),
  );

  server.registerTool(
    'browser_forward',
    {
      description: 'Navigate forward in browser history.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      await execAgentBrowser(['forward']);
      return JSON.stringify({ ok: true, message: 'Navigated forward' });
    }),
  );

  server.registerTool(
    'browser_wait',
    {
      description: 'Wait for an element to appear or for a specified time.',
      inputSchema: {
        selector: z.string().describe('CSS selector to wait for, or milliseconds (e.g., "2000")'),
        timeout: z.number().optional().default(10000).describe('Max wait time in ms (default: 10000)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const timeoutMs = args.timeout ?? 10_000;
      await execAgentBrowser(['wait', args.selector], { timeoutMs: timeoutMs + 2000 });
      return JSON.stringify({ ok: true, message: `Wait completed for: ${args.selector}` });
    }),
  );
}
