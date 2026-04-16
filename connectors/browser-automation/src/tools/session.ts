import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling } from '../utils.js';

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'browser_tabs',
    {
      description: 'List open tabs or switch to a tab by number.',
      inputSchema: {
        action: z.enum(['list', 'new', 'close']).optional().describe('Tab action. Omit to list tabs.'),
        tab_number: z.number().optional().describe('Tab number to switch to (from tab list)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (args.tab_number !== undefined) {
        await execAgentBrowser(['tab', String(args.tab_number)]);
        return JSON.stringify({ ok: true, message: `Switched to tab ${args.tab_number}` });
      }
      const cliAction = args.action ?? 'list';
      const result = await execAgentBrowser(['tab', cliAction]);
      return JSON.stringify({ ok: true, tabs: result.stdout.trim() });
    }),
  );

  server.registerTool(
    'browser_close',
    {
      description: 'Close the browser session. Sessions are saved automatically.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withErrorHandling(async () => {
      await execAgentBrowser(['close']);
      return JSON.stringify({ ok: true, message: 'Browser session closed. Sessions are saved automatically.' });
    }),
  );

  server.registerTool(
    'browser_authenticate',
    {
      description: `Open a visible browser window so the user can log in manually. The session is saved automatically.

WHEN TO USE: "I need to access LinkedIn", "Log me into WhatsApp", etc.
Tell the user to close the browser when done logging in, or call browser_close.`,
      inputSchema: {
        url: z.string().describe('Website URL to open for login'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['open', args.url], { headed: true });
      return JSON.stringify({
        ok: true,
        url: args.url,
        message: `Browser opened to ${args.url} in visible mode. The user should log in manually. Their session will be saved automatically when the browser is closed.`,
        next_step: 'Tell the user to log in and close the browser when done, or call browser_close.',
      });
    }),
  );
}
