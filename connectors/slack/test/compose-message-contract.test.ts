/**
 * compose_slack_message producer contract.
 *
 * The `_meta.ui` shape is the interactive MCP-App view contract the host
 * renders any tool result carrying it as, so every field is load-bearing —
 * asserted field-by-field, not shape-only. `structuredFallback.kind` MUST stay
 * `'plain'`: older hosts drop the whole mcpAppUiMeta on an unknown fallback
 * kind. compose_slack_message does no chat.postMessage itself; the iframe
 * invokes post_slack_message when the user clicks Send.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';
import { COMPOSE_MESSAGE_RESOURCE_URI } from '../src/tools/messages.js';
import { COMPOSE_MESSAGE_HTML } from '../src/resources/compose-message-template.js';

const CLIENT_ENV = {
  SLACK_CLIENT_ID: 'mock-client-id',
  SLACK_CLIENT_SECRET: 'mock-client-secret',
  SLACK_TEAM_ID: 'T123',
};

describe('compose_slack_message producer contract', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'USELF',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns the shared _meta.ui contract field-by-field for a channel target', async () => {
    const target = '#general';
    const text = 'Standup in five.';

    const result = await client.client.callTool({
      name: 'compose_slack_message',
      arguments: { target, text },
    });

    const structuredContent = { target, text };

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Drafting a Slack message to ${target}\n\n${JSON.stringify(structuredContent)}\n\n[View: ui://slack/compose-message]`,
      },
    ]);
    expect(result._meta).toEqual({
      ui: {
        resourceUri: 'ui://slack/compose-message',
        presentation: 'primary',
        viewSummary: 'Slack message draft to #general.',
        viewRoleLabel: 'Slack message',
        structuredFallback: {
          kind: 'plain',
          payload: {
            markdown: 'Message to #general:\n\nStandup in five.',
          },
        },
      },
    });
    expect(result.structuredContent).toEqual(structuredContent);
  });

  it('resolves and locks an intended_recipient for a DM (D…) target', async () => {
    const result = await client.client.callTool({
      name: 'compose_slack_message',
      arguments: { target: 'D999TEST', text: 'Ping' },
    });

    expect(result.isError).toBeFalsy();
    // The DM recipient (U123) rides hidden + locked into the draft so the
    // eventual post_slack_message send passes DM verification.
    expect(result.structuredContent).toEqual({
      target: 'D999TEST',
      text: 'Ping',
      intended_recipient: 'U123',
    });
  });

  it('sanitizes and truncates the viewSummary and fallback', async () => {
    const target = `#chan <b>x</b> \x1b[31m${'s'.repeat(200)}`;
    const text = 'b'.repeat(6_000);

    const result = await client.client.callTool({
      name: 'compose_slack_message',
      arguments: { target, text },
    });

    expect(result.isError).toBeFalsy();
    const ui = (result._meta as { ui: Record<string, unknown> }).ui;
    const sanitizedTarget = `#chan x ${'s'.repeat(200)}`;
    expect(ui.viewSummary).toBe(`Slack message draft to ${sanitizedTarget.slice(0, 119)}….`);

    const fallback = ui.structuredFallback as { kind: string; payload: { markdown: string } };
    expect(fallback.kind).toBe('plain');
    expect(typeof fallback.payload.markdown).toBe('string');
    // structuredContent keeps the full untruncated draft for the iframe.
    expect((result.structuredContent as { text: string }).text).toBe(text);
  });

  it('surfaces validation failures as a fail-closed tool error, not an auth envelope', async () => {
    const result = await client.client.callTool({
      name: 'compose_slack_message',
      arguments: { target: '#general', text: '   ' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('compose_slack_message requires');
    expect(text).not.toContain('auth');
  });

  it('serves the compose-message resource as the committed template HTML', async () => {
    const result = await client.client.readResource({ uri: COMPOSE_MESSAGE_RESOURCE_URI });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: 'ui://slack/compose-message',
      mimeType: 'text/html',
      text: COMPOSE_MESSAGE_HTML,
    });
  });
});
