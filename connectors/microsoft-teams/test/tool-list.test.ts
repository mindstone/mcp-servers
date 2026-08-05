import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'list_chats',
  'get_chat',
  'list_chat_messages',
  'compose_chat_message',
  'send_chat_message',
  'list_teams',
  'list_channels',
  'list_channel_messages',
  'send_channel_message',
  'reply_to_channel_message',
  'get_presence',
];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  list_chats: { readOnlyHint: true, openWorldHint: true },
  get_chat: { readOnlyHint: true, openWorldHint: true },
  list_chat_messages: { readOnlyHint: true, openWorldHint: true },
  compose_chat_message: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  send_chat_message: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_teams: { readOnlyHint: true, openWorldHint: true },
  list_channels: { readOnlyHint: true, openWorldHint: true },
  list_channel_messages: { readOnlyHint: true, openWorldHint: true },
  send_channel_message: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  reply_to_channel_message: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  get_presence: { readOnlyHint: true, openWorldHint: true },
};

describe('microsoft-teams tools/list', () => {
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

  it('registers exactly the 11 teams tools in the locked surface', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('does not register the authenticate_microsoft_account tool (auth is host-routed to Mail)', async () => {
    const response = await client.client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).not.toContain('authenticate_microsoft_account');
  });

  it('applies the locked annotations to every tool', async () => {
    const response = await client.client.listTools();
    for (const tool of response.tools) {
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected, `unknown tool: ${tool.name}`).toBeDefined();
      for (const [key, value] of Object.entries(expected)) {
        expect(
          (tool.annotations as Record<string, unknown> | undefined)?.[key],
          `${tool.name}.${key}`,
        ).toBe(value);
      }
    }
  });
});
