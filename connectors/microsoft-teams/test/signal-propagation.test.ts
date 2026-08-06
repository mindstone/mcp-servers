import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@mindstone/mcp-server-microsoft-shared';
import {
  getChat,
  getPresence,
  listChannels,
  listChats,
  listChatMessages,
  listTeams,
  sendChatMessage,
} from '../src/teams.js';

interface MockBuilder {
  options: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

interface MockSetup {
  client: Client;
  builder: MockBuilder;
}

function createMockClient(): MockSetup {
  const builder = {} as MockBuilder;
  builder.options = vi.fn().mockReturnValue(builder);
  builder.expand = vi.fn().mockReturnValue(builder);
  builder.top = vi.fn().mockReturnValue(builder);
  builder.select = vi.fn().mockReturnValue(builder);
  builder.get = vi.fn().mockResolvedValue({ value: [] });
  builder.post = vi.fn().mockResolvedValue({ id: 'msg-new' });

  const client = { api: vi.fn().mockReturnValue(builder) } as unknown as Client;
  return { client, builder };
}

describe('Graph request signal propagation', () => {
  it('listChats passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listChats(client, { top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getChat passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ id: 'chat-1', chatType: 'group' });
    const signal = new AbortController().signal;
    await getChat(client, { chatId: 'chat-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('listChatMessages passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listChatMessages(client, { chatId: 'chat-1', top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('sendChatMessage passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await sendChatMessage(client, { chatId: 'chat-1', content: 'hello' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('listTeams passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listTeams(client, {}, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('listChannels passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listChannels(client, { teamId: 'team-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getPresence passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await getPresence(client, {}, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });
});

describe('callGraph + withGraphRetry signal propagation', () => {
  it('callGraph invokes fn with a composed AbortSignal', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-teams-mock-noop');
    vi.stubEnv('MS_CLIENT_ID', 'mock-client');
    vi.resetModules();

    const sharedMock = {
      createGraphClientWithRetry: vi.fn().mockReturnValue({
        client: { api: vi.fn() },
        tokenProvider: { invalidateCachedToken: vi.fn() },
      }),
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    };
    vi.doMock('@mindstone/mcp-server-microsoft-shared', () => sharedMock);

    const { callGraph } = await import('../src/client.js');
    const fn = vi.fn(async (_client: unknown, signal: AbortSignal) => signal);
    const signal = await callGraph({}, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fn.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    vi.doUnmock('@mindstone/mcp-server-microsoft-shared');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('withGraphRetry threads the same signal into both attempts on 401', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-teams-mock-noop');
    vi.stubEnv('MS_CLIENT_ID', 'mock-client');
    vi.resetModules();

    const invalidateCachedToken = vi.fn();
    const sharedMock = {
      createGraphClientWithRetry: vi.fn().mockReturnValue({
        client: { api: vi.fn() },
        tokenProvider: { invalidateCachedToken },
      }),
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    };
    vi.doMock('@mindstone/mcp-server-microsoft-shared', () => sharedMock);

    const { withGraphRetry } = await import('../src/client.js');

    const signal = new AbortController().signal;
    const observed: AbortSignal[] = [];
    const fn = vi.fn(async (_client: unknown, s: AbortSignal) => {
      observed.push(s);
      if (observed.length === 1) {
        const err = new Error('Unauthorized') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      }
      return 'ok';
    });

    const result = await withGraphRetry(fn, signal);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(observed[0]).toBe(signal);
    expect(observed[1]).toBe(signal);
    expect(invalidateCachedToken).toHaveBeenCalledOnce();

    vi.doUnmock('@mindstone/mcp-server-microsoft-shared');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
