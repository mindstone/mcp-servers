import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@mindstone/mcp-server-microsoft-shared';
import {
  createDraft,
  createReplyDraft,
  deleteEmail,
  forwardEmail,
  getEmail,
  listEmails,
  listFolders,
  moveEmail,
  replyToEmail,
  searchEmails,
  sendEmail,
} from '../src/mail.js';

interface MockBuilder {
  options: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockClient(): { client: Client; builder: MockBuilder; apiSpy: ReturnType<typeof vi.fn> } {
  const builder = {} as MockBuilder;
  builder.options = vi.fn().mockReturnValue(builder);
  builder.select = vi.fn().mockReturnValue(builder);
  builder.search = vi.fn().mockReturnValue(builder);
  builder.top = vi.fn().mockReturnValue(builder);
  builder.get = vi.fn().mockResolvedValue({ value: [] });
  builder.post = vi.fn().mockResolvedValue({ id: 'mock-id', conversationId: 'conv-1', subject: 'Re: x' });
  builder.delete = vi.fn().mockResolvedValue(undefined);

  const apiSpy = vi.fn().mockReturnValue(builder);
  const client = { api: apiSpy } as unknown as Client;
  return { client, builder, apiSpy };
}

describe('Graph request signal propagation', () => {
  it('listEmails passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listEmails(client, { top: 5 }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getEmail passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ id: 'x' });
    const signal = new AbortController().signal;
    await getEmail(client, { id: 'msg-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('sendEmail passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await sendEmail(client, { to: 'a@example.com', subject: 's', body: 'b' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('searchEmails passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await searchEmails(client, { query: 'q' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('replyToEmail passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await replyToEmail(client, { id: 'msg-1', body: 'hi' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('forwardEmail passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await forwardEmail(client, { id: 'msg-1', to: 'a@example.com' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('deleteEmail (move) passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await deleteEmail(client, { id: 'msg-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('deleteEmail (permanent) passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await deleteEmail(client, { id: 'msg-1', permanent: true }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('listFolders passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listFolders(client, {}, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('moveEmail passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await moveEmail(client, { id: 'msg-1', destinationFolder: 'archive' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('createReplyDraft passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await createReplyDraft(client, { id: 'msg-1', body: 'hi' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('createDraft passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await createDraft(client, { subject: 's', body: 'b' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });
});

describe('callGraph + withGraphRetry signal propagation', () => {
  it('callGraph invokes fn with a composed AbortSignal', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-mail-mock-noop');
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
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-mail-mock-noop');
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
