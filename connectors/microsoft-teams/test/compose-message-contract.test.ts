/**
 * compose_chat_message producer contract.
 *
 * The `_meta.ui` shape is the interactive MCP-App view contract the host
 * renders any tool result carrying it as, so every field is load-bearing —
 * asserted field-by-field, not shape-only. `structuredFallback.kind` MUST stay
 * `'plain'`: older hosts drop the whole mcpAppUiMeta on an unknown fallback
 * kind. compose_chat_message does no Graph send itself; the iframe invokes
 * send_chat_message when the user clicks Send. Teams routes by chatId, so the
 * draft carries the target chat + text verbatim (no recipient resolution).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';
import { COMPOSE_MESSAGE_RESOURCE_URI } from '../src/tools.js';
import { COMPOSE_MESSAGE_HTML } from '../src/resources/compose-message-template.js';

describe('compose_chat_message producer contract', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns the shared _meta.ui contract field-by-field for a chat target', async () => {
    const target = 'chat-1';
    const text = 'Standup in five.';

    const result = await client.client.callTool({
      name: 'compose_chat_message',
      arguments: { target, text },
    });

    const structuredContent = { target, text };

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Drafting a Teams message to ${target}\n\n${JSON.stringify(structuredContent)}\n\n[View: ui://microsoft-teams/compose-message]`,
      },
    ]);
    expect(result._meta).toEqual({
      ui: {
        resourceUri: 'ui://microsoft-teams/compose-message',
        presentation: 'primary',
        viewSummary: 'Teams message draft to chat-1.',
        viewRoleLabel: 'Teams message',
        structuredFallback: {
          kind: 'plain',
          payload: {
            markdown: 'Message to chat-1:\n\nStandup in five.',
          },
        },
      },
    });
    expect(result.structuredContent).toEqual(structuredContent);
  });

  it('does not resolve or attach an intended_recipient (Teams routes by chatId)', async () => {
    const result = await client.client.callTool({
      name: 'compose_chat_message',
      arguments: { target: '19:meeting_abc@thread.v2', text: 'Ping' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      target: '19:meeting_abc@thread.v2',
      text: 'Ping',
    });
  });

  it('sanitizes and truncates the viewSummary while keeping the full draft', async () => {
    const target = `chat <b>x</b> \x1b[31m${'s'.repeat(200)}`;
    const text = 'b'.repeat(6_000);

    const result = await client.client.callTool({
      name: 'compose_chat_message',
      arguments: { target, text },
    });

    expect(result.isError).toBeFalsy();
    const ui = (result._meta as { ui: Record<string, unknown> }).ui;
    const sanitizedTarget = `chat x ${'s'.repeat(200)}`;
    expect(ui.viewSummary).toBe(`Teams message draft to ${sanitizedTarget.slice(0, 119)}….`);

    const fallback = ui.structuredFallback as { kind: string; payload: { markdown: string } };
    expect(fallback.kind).toBe('plain');
    expect(typeof fallback.payload.markdown).toBe('string');
    // structuredContent keeps the full untruncated draft for the iframe.
    expect((result.structuredContent as { text: string }).text).toBe(text);
  });

  it('surfaces a whitespace-only body as a fail-closed tool error, not an auth envelope', async () => {
    // `text: '   '` passes the schema's `.min(1)` but is empty once trimmed, so
    // the handler throws InvalidParams. Registered WITHOUT withErrorHandling, so
    // this surfaces as an isError result carrying the message verbatim.
    const result = await client.client.callTool({
      name: 'compose_chat_message',
      arguments: { target: 'chat-1', text: '   ' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('compose_chat_message requires');
    expect(text).not.toContain('auth');
  });

  it('serves the compose-message resource as the committed template HTML', async () => {
    const result = await client.client.readResource({ uri: COMPOSE_MESSAGE_RESOURCE_URI });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: 'ui://microsoft-teams/compose-message',
      mimeType: 'text/html',
      text: COMPOSE_MESSAGE_HTML,
    });
  });
});
