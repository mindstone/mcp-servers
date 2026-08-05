import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';

const DRIVE_SCOPES_FOR_TEST = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.activity.readonly',
].join(' ');

let cleanupDir: string | undefined;

async function loadHandlers(scopes: string = DRIVE_SCOPES_FOR_TEST) {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-drive-activity-'));
  const credentialsPath = path.join(cleanupDir, 'credentials');
  fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cleanupDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Mock API user' }],
    }),
  );
  fs.writeFileSync(
    path.join(credentialsPath, 'user-example-com.token.json'),
    JSON.stringify({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expiry_date: Date.now() + 60 * 60 * 1000,
      scope: scopes,
    }),
    { mode: 0o600 },
  );

  vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
  vi.resetModules();
  const { initializeAllServices } = await import('../src/utils/service-initializer.js');
  await initializeAllServices();
  return import('../src/tools/drive-handlers.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('query_drive_activity', () => {
  it('registers the tool definition as read-only', async () => {
    const { driveTools } = await import('../src/tools/definitions/drive.js');
    const tool = driveTools.find(t => t.name === 'query_drive_activity');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('queries activity for an ancestor and returns enveloped summaries', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.post('https://driveactivity.googleapis.com/v2/activity:query', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          activities: [{
            primaryActionDetail: { edit: {} },
            timestamp: '2026-08-04T10:00:00Z',
            actors: [{ user: { knownUser: { personName: 'people/123', isCurrentUser: false } } }],
            targets: [{ driveItem: { name: 'items/file-1', title: 'Q3 Plan', mimeType: 'application/vnd.google-apps.document' } }],
          }],
          nextPageToken: 'activity-page-2',
        });
      }),
    );
    const handlers = await loadHandlers();
    const result = await handlers.handleQueryDriveActivity({
      email: TEST_EMAIL,
      ancestor_id: 'folder-1',
      filter: 'time >= "2026-07-01T00:00:00Z"',
    }) as { activities: Array<{ action: string; targets: Array<{ title?: string }> }>; nextPageToken: string };

    // Bare ID normalized to the API resource form; filter passed through
    expect(sentBody?.ancestorName).toBe('items/folder-1');
    expect(sentBody?.filter).toBe('time >= "2026-07-01T00:00:00Z"');
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0].action).toBe('edit');
    // Attacker-controlled file titles must be enveloped
    expect(result.activities[0].targets[0].title).toContain('<untrusted-content');
    expect(result.activities[0].targets[0].title).toContain('Q3 Plan');
    expect(result.nextPageToken).toBe('activity-page-2');
  });

  it('caps page_size at 100', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.post('https://driveactivity.googleapis.com/v2/activity:query', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ activities: [] });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleQueryDriveActivity({ email: TEST_EMAIL, item_id: 'file-1', page_size: 500 });
    expect(sentBody?.itemName).toBe('items/file-1');
    expect(sentBody?.pageSize).toBe(100);
  });

  it('rejects calls with neither or both of item_id / ancestor_id', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleQueryDriveActivity({ email: TEST_EMAIL }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      handlers.handleQueryDriveActivity({ email: TEST_EMAIL, item_id: 'a', ancestor_id: 'b' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('surfaces the real API error on failure', async () => {
    mswServer.use(
      http.post('https://driveactivity.googleapis.com/v2/activity:query', () => HttpResponse.json(
        { error: { message: 'The request is missing a valid API key.' } },
        { status: 403 },
      )),
    );
    const handlers = await loadHandlers();
    await expect(
      handlers.handleQueryDriveActivity({ email: TEST_EMAIL, item_id: 'file-1' }),
    ).rejects.toThrow(/403|missing a valid API key/);
  });

  it('fails with reconnect guidance when the activity scope was not granted', async () => {
    const handlers = await loadHandlers('https://www.googleapis.com/auth/drive');
    await expect(
      handlers.handleQueryDriveActivity({ email: TEST_EMAIL, item_id: 'file-1' }),
    ).rejects.toThrow(/Drive Activity/);
  });
});
