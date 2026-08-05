import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@mindstone/mcp-server-microsoft-shared';
import {
  createEvent,
  deleteEvent,
  findMeetingTimes,
  getEvent,
  getFreeBusy,
  listCalendars,
  listEvents,
  respondToEvent,
  updateEvent,
} from '../src/calendar.js';

interface MockBuilder {
  options: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface MockSetup {
  client: Client;
  builder: MockBuilder;
  apiSpy: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockSetup {
  const builder = {} as MockBuilder;
  builder.options = vi.fn().mockReturnValue(builder);
  builder.select = vi.fn().mockReturnValue(builder);
  builder.query = vi.fn().mockReturnValue(builder);
  builder.get = vi.fn().mockImplementation(async () => {
    // Default: distinguish mailboxSettings vs other GET endpoints.
    return { value: [], timeZone: 'UTC' };
  });
  builder.post = vi.fn().mockResolvedValue({ id: 'mock-id', value: [] });
  builder.patch = vi.fn().mockResolvedValue(undefined);
  builder.delete = vi.fn().mockResolvedValue(undefined);

  const apiSpy = vi.fn().mockReturnValue(builder);
  const client = { api: apiSpy } as unknown as Client;
  return { client, builder, apiSpy };
}

describe('Graph request signal propagation', () => {
  it('listEvents passes signal to GraphRequest.options on every call', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listEvents(client, { top: 5, deviceTimezone: 'America/New_York' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
    // listEvents fans out: mailboxSettings + calendarView — two .options() invocations expected.
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('getEvent passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ id: 'evt-1' });
    const signal = new AbortController().signal;
    await getEvent(client, { id: 'evt-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('createEvent passes signal to GraphRequest.options for both timezone lookup and POST', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ timeZone: 'UTC' });
    builder.post.mockResolvedValueOnce({ id: 'new-1' });
    const signal = new AbortController().signal;
    await createEvent(
      client,
      {
        subject: 'X',
        start: '2026-05-20T09:00:00',
        end: '2026-05-20T10:00:00',
        deviceTimezone: 'America/New_York',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('updateEvent passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await updateEvent(client, { id: 'evt-1', subject: 'New' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('updateEvent with start/end fetches timezone first, propagating signal', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ timeZone: 'UTC' });
    const signal = new AbortController().signal;
    await updateEvent(
      client,
      {
        id: 'evt-1',
        start: '2026-05-20T09:00:00',
        end: '2026-05-20T10:00:00',
        deviceTimezone: 'America/New_York',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('deleteEvent passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await deleteEvent(client, { id: 'evt-1' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('respondToEvent passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await respondToEvent(client, { id: 'evt-1', response: 'accept' }, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });

  it('getFreeBusy passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ timeZone: 'UTC' });
    builder.post.mockResolvedValueOnce({ value: [] });
    const signal = new AbortController().signal;
    await getFreeBusy(
      client,
      {
        emails: ['alice@example.com'],
        startDateTime: '2026-05-20T08:00:00Z',
        endDateTime: '2026-05-20T18:00:00Z',
        deviceTimezone: 'America/New_York',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('findMeetingTimes passes signal to GraphRequest.options for both timezone lookup and POST', async () => {
    const { client, builder } = createMockClient();
    builder.get.mockResolvedValueOnce({ timeZone: 'UTC' });
    builder.post.mockResolvedValueOnce({ value: [] });
    const signal = new AbortController().signal;
    await findMeetingTimes(
      client,
      {
        attendees: ['alice@example.com'],
        startDateTime: '2026-05-20T09:00:00',
        endDateTime: '2026-05-20T12:00:00',
        durationMinutes: 30,
        deviceTimezone: 'America/New_York',
      },
      signal,
    );
    expect(builder.options).toHaveBeenCalledWith({ signal });
    expect(builder.options.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('listCalendars passes signal to GraphRequest.options', async () => {
    const { client, builder } = createMockClient();
    const signal = new AbortController().signal;
    await listCalendars(client, signal);
    expect(builder.options).toHaveBeenCalledWith({ signal });
  });
});

describe('callGraph + withGraphRetry signal propagation', () => {
  it('callGraph invokes fn with a composed AbortSignal', async () => {
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-calendar-mock-noop');
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
    vi.stubEnv('MS_CONFIG_DIR', '/tmp/microsoft-calendar-mock-noop');
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
