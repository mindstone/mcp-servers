import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling } from '../utils.js';

export function registerInteractionTools(server: McpServer): void {
  server.registerTool(
    'browser_click',
    {
      description: `Click an element. Use @ref from browser_snapshot (preferred) or a CSS selector.

WORKFLOW: browser_snapshot → find @ref → browser_click @ref`,
      inputSchema: {
        ref: z.string().describe('Element ref from snapshot (e.g., "@e2") or CSS selector'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['click', args.ref]);
      return JSON.stringify({ ok: true, message: `Clicked: ${args.ref}` });
    }),
  );

  server.registerTool(
    'browser_fill',
    {
      description: `Clear a field and fill it with text. Use @ref from browser_snapshot.

WORKFLOW: browser_snapshot → find input @ref → browser_fill`,
      inputSchema: {
        ref: z.string().describe('Element ref (e.g., "@e3") or CSS selector'),
        value: z.string().describe('Text to fill'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['fill', args.ref, args.value]);
      return JSON.stringify({ ok: true, message: `Filled ${args.ref} with ${args.value.length} characters` });
    }),
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Type text character by character (simulates real keystrokes). Useful for search boxes and autocompletes that respond to individual key events.',
      inputSchema: {
        ref: z.string().describe('Element ref or CSS selector'),
        text: z.string().describe('Text to type'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['type', args.ref, args.text]);
      return JSON.stringify({ ok: true, message: `Typed ${args.text.length} characters into ${args.ref}` });
    }),
  );

  server.registerTool(
    'browser_press_key',
    {
      description: 'Press a keyboard key. Common keys: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp.',
      inputSchema: {
        key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape")'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['press', args.key]);
      return JSON.stringify({ ok: true, message: `Pressed key: ${args.key}` });
    }),
  );

  server.registerTool(
    'browser_scroll',
    {
      description: 'Scroll the page in a direction.',
      inputSchema: {
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
        amount: z.number().optional().default(500).describe('Pixels to scroll (default: 500)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const px = args.amount ?? 500;
      await execAgentBrowser(['scroll', args.direction, String(px)]);
      return JSON.stringify({ ok: true, message: `Scrolled ${args.direction} ${px}px` });
    }),
  );

  server.registerTool(
    'browser_select',
    {
      description: 'Select an option from a dropdown.',
      inputSchema: {
        ref: z.string().describe('Element ref or CSS selector for the <select>'),
        value: z.string().describe('Option value or visible text to select'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['select', args.ref, args.value]);
      return JSON.stringify({ ok: true, message: `Selected "${args.value}" in ${args.ref}` });
    }),
  );

  server.registerTool(
    'browser_hover',
    {
      description: 'Hover over an element (triggers hover menus/tooltips).',
      inputSchema: {
        ref: z.string().describe('Element ref or CSS selector'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      await execAgentBrowser(['hover', args.ref]);
      return JSON.stringify({ ok: true, message: `Hovering over ${args.ref}` });
    }),
  );

  // M3.12 — `browser_evaluate` lets the model run arbitrary JavaScript inside
  // the page context, which is the security equivalent of giving it a shell
  // on whatever site it has just navigated to. To prevent prompt-injected
  // content from doing this silently, the tool is registered ONLY when the
  // host explicitly opts in via `BROWSER_AUTOMATION_ALLOW_EVAL=1`. Without
  // that env var the tool is not in the tools list at all (the LLM cannot
  // even see it). When enabled it carries `destructiveHint: true` so MCP
  // hosts can require explicit user confirmation before each invocation.
  if (process.env.BROWSER_AUTOMATION_ALLOW_EVAL === '1') {
    server.registerTool('browser_evaluate', // eslint-disable-line @typescript-eslint/quotes
      {
        description:
          'Execute JavaScript in the page context and return the result. ' +
          'DESTRUCTIVE: this is equivalent to running arbitrary code with the privileges of the current page; ' +
          'hosts SHOULD require user confirmation before each call. ' +
          'Only registered when BROWSER_AUTOMATION_ALLOW_EVAL=1 is set.',
        inputSchema: {
          script: z.string().describe('JavaScript code to execute'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      withErrorHandling(async (args) => {
        const result = await execAgentBrowser(['eval', args.script]);
        return JSON.stringify({ ok: true, result: result.stdout.trim() });
      }),
    );
  }
}
