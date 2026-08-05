import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Every tool validates its required arguments in the business layer and must
// surface the TeamsBusinessError guidance envelope ({ ok: false, error,
// action_required, next_step }) rather than a raw Graph error — and must not
// call Graph at all when a required argument is effectively missing.
const EMPTY_ARG_CASES: Array<{ tool: string; args: Record<string, unknown>; param: string }> = [
  { tool: 'get_chat', args: { chatId: '' }, param: 'chatId' },
  { tool: 'list_chat_messages', args: { chatId: '  ' }, param: 'chatId' },
  { tool: 'send_chat_message', args: { chatId: 'chat-1', content: '' }, param: 'content' },
  { tool: 'reply_to_message', args: { chatId: 'chat-1', messageId: '', content: 'Hi' }, param: 'messageId' },
  { tool: 'list_channels', args: { teamId: '' }, param: 'teamId' },
  { tool: 'list_channel_messages', args: { teamId: 'team-1', channelId: '' }, param: 'channelId' },
  {
    tool: 'send_channel_message',
    args: { teamId: 'team-1', channelId: '', content: 'Hi' },
    param: 'channelId',
  },
  {
    tool: 'reply_to_channel_message',
    args: { teamId: 'team-1', channelId: 'channel-1', messageId: '', content: 'Hi' },
    param: 'messageId',
  },
  { tool: 'find_user', args: { query: '' }, param: 'query' },
  { tool: 'create_chat', args: { members: [''] }, param: 'members' },
  { tool: 'search_messages', args: { query: '   ' }, param: 'query' },
  { tool: 'get_user_presence', args: { userId: '' }, param: 'userId' },
];

describe('missing-argument guidance errors', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

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
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  for (const { tool, args, param } of EMPTY_ARG_CASES) {
    it(`${tool} returns the guidance envelope when "${param}" is empty`, async () => {
      const result = await client.callTool(tool, args);
      expect(result.isError).toBe(true);
      const json = result.json as {
        ok: boolean;
        error: string;
        action_required: string;
        next_step: string;
      };
      expect(json.ok).toBe(false);
      expect(json.error).toContain(`"${param}"`);
      expect(json.action_required).toBeTruthy();
      expect(json.next_step).toBe(tool);

      const graphCalls = state.requests.filter((r) => r.url.includes('graph.microsoft.com'));
      expect(graphCalls).toEqual([]);
    });
  }

  it('create_chat rejects a non-array members argument with guidance', async () => {
    const result = await client.callTool('create_chat', { members: 'alice@example.com' });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toBeTruthy();
    const graphCalls = state.requests.filter((r) => r.url.includes('graph.microsoft.com'));
    expect(graphCalls).toEqual([]);
  });

  it('set_presence rejects an unknown availability at the schema boundary', async () => {
    // availability is a Zod enum, so invalid values never reach the handler —
    // the SDK's enum message already lists the valid values.
    const result = await client.callTool('set_presence', { availability: 'OnLunch' });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('Available');
    const graphCalls = state.requests.filter((r) => r.url.includes('graph.microsoft.com'));
    expect(graphCalls).toEqual([]);
  });

  // durationMinutes must be a whole number in 5-480; out-of-range or fractional
  // values are rejected at the schema boundary, never silently clamped/rounded
  // into a different meaning before a network write.
  const INVALID_DURATION_CASES = [-100, 4, 480.9, 1000000, 5.5];
  for (const durationMinutes of INVALID_DURATION_CASES) {
    it(`set_presence rejects durationMinutes=${durationMinutes} instead of coercing it`, async () => {
      const result = await client.callTool('set_presence', {
        availability: 'Busy',
        durationMinutes,
      });
      expect(result.isError).toBe(true);
      const graphCalls = state.requests.filter((r) => r.url.includes('graph.microsoft.com'));
      expect(graphCalls).toEqual([]);
    });
  }
});

describe('setPresence business-layer duration guard', () => {
  // The tool schema is the primary boundary; the business layer must also fail
  // closed for direct callers rather than silently coercing.
  it('rejects out-of-range and fractional durations without calling Graph', async () => {
    const { setPresence } = await import('../src/teams.js');
    const client = { api: () => ({ options: () => ({ post: async () => ({}) }) }) };
    for (const durationMinutes of [0, 3, 480.5, 1000000]) {
      await expect(
        setPresence(
          client as unknown as import('@mindstone/mcp-server-microsoft-shared').Client,
          { availability: 'Busy', durationMinutes },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/durationMinutes/);
    }
  });
});
