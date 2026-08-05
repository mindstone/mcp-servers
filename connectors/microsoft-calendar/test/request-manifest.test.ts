import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

interface ManifestRow {
  tool: string;
  method: string;
  /** Pathname pattern: `:param` matches anything between slashes. */
  pathname: string;
  /** Args that produce the call. */
  args: Record<string, unknown>;
}

/**
 * Pinned per-tool Graph endpoint contract. Acts as a drift-detection gate so
 * a future refactor cannot silently change a tool's underlying request shape.
 */
const MANIFEST: ManifestRow[] = [
  {
    tool: 'list_events',
    method: 'GET',
    pathname: '/v1.0/me/calendarView',
    args: { top: 1, deviceTimezone: 'America/New_York' },
  },
  {
    tool: 'get_event',
    method: 'GET',
    pathname: '/v1.0/me/events/:id',
    args: { id: 'AAMkAGI2' },
  },
  {
    tool: 'create_event',
    method: 'POST',
    pathname: '/v1.0/me/events',
    args: {
      subject: 'Team Sync',
      start: '2026-05-20T09:00:00',
      end: '2026-05-20T10:00:00',
      deviceTimezone: 'America/New_York',
    },
  },
  {
    tool: 'update_event',
    method: 'PATCH',
    pathname: '/v1.0/me/events/:id',
    args: { id: 'event-1', subject: 'Updated Title' },
  },
  {
    tool: 'delete_event',
    method: 'DELETE',
    pathname: '/v1.0/me/events/:id',
    args: { id: 'event-1' },
  },
  {
    tool: 'respond_to_event',
    method: 'POST',
    pathname: '/v1.0/me/events/:id/accept',
    args: { id: 'event-1', response: 'accept' },
  },
  {
    tool: 'get_free_busy',
    method: 'POST',
    pathname: '/v1.0/me/calendar/getSchedule',
    args: {
      emails: ['alice@example.com'],
      startDateTime: '2026-05-20T08:00:00Z',
      endDateTime: '2026-05-20T18:00:00Z',
      deviceTimezone: 'America/New_York',
    },
  },
  {
    tool: 'list_calendars',
    method: 'GET',
    pathname: '/v1.0/me/calendars',
    args: {},
  },
  {
    tool: 'find_meeting_times',
    method: 'POST',
    pathname: '/v1.0/me/calendar/getSchedule',
    args: {
      attendees: ['alice@example.com'],
      startDateTime: '2026-05-21T09:00:00',
      endDateTime: '2026-05-21T12:00:00',
      durationMinutes: 30,
      deviceTimezone: 'America/New_York',
    },
  },
];

function matchPath(actual: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[\.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$',
  );
  return regex.test(actual);
}

const AUTH_HOST = ['login', 'microsoftonline', 'com'].join('.');
function isAuthEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname === AUTH_HOST;
  } catch {
    return false;
  }
}

describe('request manifest — Graph endpoint contract', () => {
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

  for (const row of MANIFEST) {
    it(`${row.tool} → ${row.method} ${row.pathname}`, async () => {
      await client.callTool(row.tool, row.args);
      const match = state.requests.find(
        (r) =>
          r.method === row.method &&
          matchPath(r.pathname, row.pathname) &&
          !isAuthEndpoint(r.url),
      );
      expect(
        match,
        `${row.tool}: no ${row.method} request matched ${row.pathname} (saw ${state.requests
          .map((r) => `${r.method} ${r.pathname}`)
          .join(', ')})`,
      ).toBeDefined();
    });
  }
});
