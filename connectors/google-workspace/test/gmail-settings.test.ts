import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
].join(' ');

let cleanupDir: string | undefined;

async function loadHandlers() {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-gmail-settings-'));
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
      scope: GMAIL_SCOPES,
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
  return import('../src/tools/gmail-handlers.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('gmail settings write/read tools', () => {
  it('exposes vacation responder and send-as definitions', async () => {
    const { gmailTools } = await import('../src/tools/definitions/gmail.js');
    const vacation = gmailTools.find(tool => tool.name === 'update_workspace_vacation_responder');
    const sendAs = gmailTools.find(tool => tool.name === 'list_workspace_send_as');
    expect(vacation).toBeDefined();
    expect(vacation?.inputSchema.required).toContain('enabled');
    expect(vacation?.annotations?.readOnlyHint).toBe(false);
    expect(sendAs).toBeDefined();
    expect(sendAs?.annotations?.readOnlyHint).toBe(true);
  });

  it('enables the vacation responder, preserving an existing subject', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseSubject: 'Away',
        responseBodyPlainText: 'I am out.',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          enableAutoReply: sentBody.enableAutoReply,
          responseSubject: sentBody.responseSubject,
          responseBodyPlainText: sentBody.responseBodyPlainText,
          startTime: sentBody.startTime,
        });
      }),
    );
    const handlers = await loadHandlers();
    const result = await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      response_body: 'Back on Monday.',
    }) as { enabled: boolean; message: string };

    expect(sentBody?.enableAutoReply).toBe(true);
    // Existing subject merged, caller body wins
    expect(sentBody?.responseSubject).toBe('Away');
    expect(sentBody?.responseBodyPlainText).toBe('Back on Monday.');
    // startTime defaulted to "now" when enabling
    expect(typeof sentBody?.startTime).toBe('string');
    expect(result.enabled).toBe(true);
    expect(result.message).toContain('<untrusted-content');
  });

  it('disables the vacation responder without a message', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyPlainText: 'I am out.',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: false });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({ email: TEST_EMAIL, enabled: false });
    expect(sentBody?.enableAutoReply).toBe(false);
  });

  it('requires a message when enabling with no existing auto-reply', async () => {
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
      })),
    );
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({ email: TEST_EMAIL, enabled: true }),
    ).rejects.toThrow(/needs a message/);
  });

  it('rejects missing enabled flag', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({ email: TEST_EMAIL }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects Unix-seconds timestamps with an actionable message', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({
        email: TEST_EMAIL,
        enabled: false,
        end_time: '1786464000', // seconds, not ms — must not silently become 1970-adjacent
      }),
    ).rejects.toThrow(/epoch milliseconds/);
  });

  it('rejects numeric Unix-seconds timestamps too', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({
        email: TEST_EMAIL,
        enabled: false,
        end_time: 1786464000, // seconds as a number — same 1000x-off hazard as the string form
      }),
    ).rejects.toThrow(/epoch milliseconds/);
  });

  it('accepts numeric epoch-millisecond timestamps', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseBodyPlainText: 'I am out.',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      end_time: 1786464000000,
    });
    expect(sentBody?.endTime).toBe('1786464000000');
  });

  it('preserves a pending scheduled end on an unrelated update', async () => {
    const futureEnd = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyPlainText: 'I am out.',
        endTime: futureEnd,
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      response_subject: 'Still away',
    });
    // The Gmail API replaces the whole resource — omitting endTime would erase the scheduled end.
    expect(sentBody?.endTime).toBe(futureEnd);
    expect(sentBody?.responseSubject).toBe('Still away');
  });

  it('clear_end_time explicitly removes a scheduled end', async () => {
    const futureEnd = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: true,
        responseBodyPlainText: 'I am out.',
        endTime: futureEnd,
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      clear_end_time: true,
    });
    expect(sentBody && 'endTime' in sentBody).toBe(false);
  });

  it('rejects clear_end_time combined with end_time', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({
        email: TEST_EMAIL,
        enabled: true,
        end_time: '2026-08-10',
        clear_end_time: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('does not inherit an already-past scheduled end when re-enabling', async () => {
    const pastEnd = String(Date.now() - 24 * 60 * 60 * 1000);
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseBodyPlainText: 'I am out.',
        endTime: pastEnd,
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({ email: TEST_EMAIL, enabled: true });
    // A stale end would violate the API's start < end constraint and expire the reply instantly.
    expect(sentBody && 'endTime' in sentBody).toBe(false);
  });

  it('preserves an HTML-only body as HTML instead of flattening it to plain text', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyHtml: '<div>I am <b>out</b>.</div>',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      response_subject: 'Still away',
    });
    expect(sentBody?.responseBodyHtml).toBe('<div>I am <b>out</b>.</div>');
    expect(sentBody && 'responseBodyPlainText' in sentBody).toBe(false);
  });

  it('treats an existing HTML body as satisfying the message requirement when enabling', async () => {
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseBodyHtml: '<div>I am out.</div>',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        const sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          enableAutoReply: sentBody.enableAutoReply,
          responseBodyHtml: sentBody.responseBodyHtml,
        });
      }),
    );
    const handlers = await loadHandlers();
    const result = await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
    }) as { enabled: boolean };
    expect(result.enabled).toBe(true);
  });

  it('accepts ISO date strings for start/end times', async () => {
    let sentBody: Record<string, unknown> | undefined;
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseBodyPlainText: 'I am out.',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', async ({ request }) => {
        sentBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ enableAutoReply: true });
      }),
    );
    const handlers = await loadHandlers();
    await handlers.handleUpdateWorkspaceVacationResponder({
      email: TEST_EMAIL,
      enabled: true,
      end_time: '2026-08-10',
    });
    expect(sentBody?.endTime).toBe(String(Date.parse('2026-08-10')));
  });

  it('lists send-as aliases with enveloped signatures and display names', async () => {
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', () => HttpResponse.json({
        sendAs: [{
          sendAsEmail: TEST_EMAIL,
          displayName: 'Example User',
          signature: '<div>Regards, Example</div>',
          isPrimary: true,
          isDefault: true,
          verificationStatus: 'accepted',
        }],
      })),
    );
    const handlers = await loadHandlers();
    const result = await handlers.handleListWorkspaceSendAs({ email: TEST_EMAIL }) as {
      sendAs: Array<{ sendAsEmail: string; displayName: string; signature: string }>;
    };
    expect(result.sendAs).toHaveLength(1);
    expect(result.sendAs[0].sendAsEmail).toContain(TEST_EMAIL);
    expect(result.sendAs[0].displayName).toContain('<untrusted-content');
    expect(result.sendAs[0].signature).toContain('<untrusted-content');
  });

  it('surfaces the real Gmail API error when the update fails', async () => {
    mswServer.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json({
        enableAutoReply: false,
        responseBodyPlainText: 'I am out.',
      })),
      http.put('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', () => HttpResponse.json(
        { error: { message: 'Invalid vacation settings' } },
        { status: 400 },
      )),
    );
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateWorkspaceVacationResponder({ email: TEST_EMAIL, enabled: true }),
    ).rejects.toThrow(/Invalid vacation settings/);
  });
});
