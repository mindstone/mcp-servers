import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';

const EMAIL = 'user@example.com';
const EVENTS_ROOT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

type ToolResponse = {
  isError?: boolean;
  content: Array<{ text: string }>;
};

let directory: string | undefined;

async function loadServer() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-delete-retry-'));
  const credentials = path.join(directory, 'credentials');
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify({
    accounts: [{ email: EMAIL, category: 'work' }],
  }));
  fs.writeFileSync(path.join(credentials, 'user-example-com.token.json'), JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expiry_date: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/calendar',
  }));

  vi.stubEnv('ACCOUNTS_PATH', path.join(directory, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentials);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', directory);
  vi.resetModules();

  const { initializeAllServices } = await import('../src/utils/service-initializer.js');
  await initializeAllServices();
  const { GSuiteServer } = await import('../src/tools/server.js');
  const server = new GSuiteServer() as unknown as {
    server: {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResponse>>;
    };
  };
  const handler = server.server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('Tool call handler is not registered');

  return async (eventId: string): Promise<ToolResponse> => handler({
    method: 'tools/call',
    params: {
      name: 'delete_workspace_calendar_event',
      arguments: {
        email: EMAIL,
        event_id: eventId,
        deletion_scope: 'this_and_following',
      },
    },
  }, {});
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('calendar this_and_following PATCH failures', () => {
  it.each([
    { branch: 'master', status: 429, eventId: 'master-event' },
    { branch: 'master', status: 500, eventId: 'master-event' },
    { branch: 'instance', status: 429, eventId: 'instance-event' },
    { branch: 'instance', status: 500, eventId: 'instance-event' },
  ])('does not delete or report success when the $branch recurrence PATCH returns $status', async ({ branch, status, eventId }) => {
    let patchRequests = 0;
    let deleteRequests = 0;
    mswServer.use(
      http.get(`${EVENTS_ROOT}/:eventId`, ({ params }) => {
        const requestedId = String(params.eventId);
        if (requestedId === 'instance-event') {
          return HttpResponse.json({
            id: 'instance-event',
            recurringEventId: 'master-event',
            start: { dateTime: '2026-01-02T10:00:00Z' },
          });
        }
        return HttpResponse.json({
          id: 'master-event',
          recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
          start: { dateTime: '2026-01-01T10:00:00Z' },
        });
      }),
      http.patch(`${EVENTS_ROOT}/:eventId`, () => {
        patchRequests++;
        return HttpResponse.json({ error: { code: status, message: `Calendar PATCH failed (${status})` } }, { status });
      }),
      http.delete(`${EVENTS_ROOT}/:eventId`, () => {
        deleteRequests++;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const call = await loadServer();
    const response = await call(eventId);
    const envelope = JSON.parse(response.content[0].text) as Record<string, unknown>;

    expect(patchRequests).toBe(1);
    expect(deleteRequests).toBe(0);
    expect(response.isError).toBe(true);
    expect(envelope.status).not.toBe('success');
  });
});
