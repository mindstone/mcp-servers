import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';

let cleanupDir: string | undefined;

/**
 * Sets up an account whose token is EXPIRED. The OAuth refresh endpoint is
 * mocked per test: a 500 makes every refresh a transient blip (withTokenRenewal
 * proceeds and the failure surfaces in the service layer — the gap this file
 * guards); a 400 invalid_grant is a dead grant (reconnect required).
 */
async function loadHandlers() {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-auth-gap-'));
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
      access_token: 'expired-access-token',
      refresh_token: 'mock-refresh-token',
      expiry_date: Date.now() - 60 * 1000,
      scope: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/presentations',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/forms.body.readonly',
      ].join(' '),
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

  const [tasks, docs, slides, comments, forms, contacts, server] = await Promise.all([
    import('../src/tools/tasks-handlers.js'),
    import('../src/tools/docs-handlers.js'),
    import('../src/tools/slides-handlers.js'),
    import('../src/tools/comments-handlers.js'),
    import('../src/tools/forms-handlers.js'),
    import('../src/tools/contacts-handlers.js'),
    import('../src/tools/server.js'),
  ]);
  const formatErrorResponse = (error: unknown) => (
    new server.GSuiteServer() as unknown as { formatErrorResponse(error: unknown): unknown }
  ).formatErrorResponse(error);
  return { tasks, docs, slides, comments, forms, contacts, formatErrorResponse };
}

function mockRefresh(status: number, body: unknown): void {
  mswServer.use(
    http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json(body, { status })),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('service-layer auth failures keep their signal', () => {
  it('transient refresh blip surfaces as a retryable auth error, not a flattened string (Tasks)', async () => {
    mockRefresh(500, { error: 'internal error' });
    const { tasks } = await loadHandlers();
    const error = await tasks.handleListTaskLists({ email: TEST_EMAIL }).catch(e => e);
    expect((error as { code?: unknown }).code).toBe('TEMPORARY_AUTH_ERROR');
  }, 30000);

  it.each([
    ['Forms', 'forms', 'handleListForms', {}],
    ['Docs', 'docs', 'handleReadDocument', { document_id: 'doc-1' }],
    ['Slides', 'slides', 'handleReadPresentation', { presentation_id: 'pres-1' }],
    ['Comments', 'comments', 'handleListComments', { file_id: 'file-1' }],
    ['Contacts', 'contacts', 'handleGetContacts', { person_fields: 'names' }],
  ] as const)('%s: transient blip keeps TEMPORARY_AUTH_ERROR', async (_label, mod, fn, extra) => {
    mockRefresh(500, { error: 'internal error' });
    const handlers = await loadHandlers();
    const handler = (handlers[mod] as Record<string, (p: unknown) => Promise<unknown>>)[fn];
    const error = await handler({ email: TEST_EMAIL, ...extra }).catch((e: unknown) => e);
    expect((error as { code?: unknown }).code).toBe('TEMPORARY_AUTH_ERROR');
  }, 30000);

  it('dead grant surfaces AUTH_REQUIRED and maps to the auth_required handoff', async () => {
    mockRefresh(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
    const { tasks, formatErrorResponse } = await loadHandlers();
    const error = await tasks.handleListTaskLists({ email: TEST_EMAIL }).catch(e => e);
    expect((error as { code?: unknown }).code).toBe('AUTH_REQUIRED');

    const response = formatErrorResponse(error) as { status?: string; setupToolName?: string };
    expect(response.status).toBe('auth_required');
    expect(response.setupToolName).toBe('authenticate_workspace_account');
  });

  it('dead grant in Docs/Comments also keeps AUTH_REQUIRED through the service catch', async () => {
    mockRefresh(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
    const { docs, comments } = await loadHandlers();
    const docsError = await docs.handleReadDocument({ email: TEST_EMAIL, document_id: 'doc-1' }).catch(e => e);
    expect((docsError as { code?: unknown }).code).toBe('AUTH_REQUIRED');
    const commentsError = await comments.handleListComments({ email: TEST_EMAIL, file_id: 'file-1' }).catch(e => e);
    expect((commentsError as { code?: unknown }).code).toBe('AUTH_REQUIRED');
  });
});
