import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

describe('Slack MCP startup with saved workspace tokens', () => {
  let client: McpTestClient | undefined;
  let cfg: SlackTestConfig | undefined;

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    vi.unstubAllEnvs();
  });

  it('starts and serves tools from saved tokens even when local OAuth client credentials are absent', async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock-bot-token',
        userToken: 'xoxp-mock-user-token',
        botUserId: 'U999BOT',
      },
    });

    client = await createTestClient({
      env: {
        SLACK_TEAM_ID: 'T123',
        SLACK_CONFIG_PATH: cfg.configPath,
        SLACK_CLIENT_ID: '',
        SLACK_CLIENT_SECRET: '',
      },
    });

    const tools = await client.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('list_slack_channels');

    const result = await client.callTool('list_slack_channels', {});
    expect(result.json).toMatchObject({ ok: true });
  });
});
