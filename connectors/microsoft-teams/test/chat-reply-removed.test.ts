import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Microsoft Graph has no replies route for chat messages (only channel
// messages have threaded replies), so the connector must not offer a chat
// reply tool, and its chat tools must say plainly that chats are flat.
const NO_THREADS = /Teams chats have no threaded replies/;

describe('microsoft-teams chat replies', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  const outbound: string[] = [];
  const onRequest = ({ request }: { request: Request }) => {
    outbound.push(`${request.method} ${new URL(request.url).pathname}`);
  };

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    outbound.length = 0;
    mswServer.use(...createMockApi().handlers);
    // Every request MSW intercepts, matched by a handler or not.
    mswServer.events.on('request:start', onRequest);
  });

  afterEach(() => {
    mswServer.events.removeListener('request:start', onRequest);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('rejects reply_to_message as an unknown tool and makes no Graph request', async () => {
    // The SDK may report an unknown tool as an error result or a thrown error.
    let isError: boolean | undefined;
    let failure: string;
    try {
      const result = await client.callTool('reply_to_message', {
        chatId: 'chat-1',
        messageId: 'msg-1',
        content: 'On it',
      });
      isError = result.isError;
      failure = result.text;
    } catch (error) {
      isError = true;
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(outbound).toEqual([]);
    expect(isError).toBe(true);
    expect(failure).toMatch(/reply_to_message/);
    expect(failure).toMatch(/not found|unknown/i);
  });

  it('does not list reply_to_message and keeps reply_to_channel_message', async () => {
    const { tools } = await client.client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('reply_to_message');
    expect(names).toContain('reply_to_channel_message');
  });

  it.each(['send_chat_message', 'compose_chat_message', 'list_chat_messages'])(
    '%s says chats have no threaded replies and a reply goes as a new message',
    async (name) => {
      const { tools } = await client.client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description ?? '').toMatch(NO_THREADS);
      expect(tool!.description ?? '').toMatch(/new message/);
      expect(tool!.description ?? '').toMatch(/tell the user/);
    },
  );
});
