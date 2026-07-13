import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import manifest from './request-manifest.json';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';
const VALID_SLIDES_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd';
const GOOGLE_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly',
].join(' ');

type MockEndpoint = { method: string; path: string };

let cleanupDir: string | undefined;

function endpoint(method: string, path: string): MockEndpoint {
  return { method, path };
}

const mockedEndpoints = [
  endpoint('GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages'),
  endpoint('POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send'),
  endpoint('GET', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events'),
  endpoint('POST', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events'),
  endpoint('GET', 'https://www.googleapis.com/drive/v3/files'),
  endpoint('GET', 'https://www.googleapis.com/drive/v3/drives'),
  endpoint('POST', 'https://www.googleapis.com/upload/drive/v3/files'),
  endpoint('GET', 'https://docs.googleapis.com/v1/documents/{documentId}'),
  endpoint('POST', 'https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate'),
  endpoint('GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}'),
  endpoint('GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}'),
  endpoint('PUT', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}'),
  endpoint('GET', 'https://slides.googleapis.com/v1/presentations/{presentationId}'),
  endpoint('POST', 'https://slides.googleapis.com/v1/presentations/{presentationId}:batchUpdate'),
  endpoint('GET', 'https://people.googleapis.com/v1/people/me/connections'),
  endpoint('GET', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks'),
  endpoint('POST', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks'),
  endpoint('GET', 'https://forms.googleapis.com/v1/forms/{formId}/responses'),
  endpoint('GET', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments'),
  endpoint('POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments'),
] as const;

function createWorkspaceEnv(): void {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-mock-api-'));
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
      scope: GOOGLE_SCOPES,
    }),
    { mode: 0o600 },
  );

  vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
  vi.stubEnv('ENABLE_GOOGLE_TASKS_FORMS', 'true');
  vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
}

async function loadHandlers(extraEnv: Record<string, string> = {}) {
  createWorkspaceEnv();
  for (const [key, value] of Object.entries(extraEnv)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const { initializeAllServices } = await import('../src/utils/service-initializer.js');
  await initializeAllServices();

  const [
    gmail,
    calendar,
    drive,
    docs,
    sheets,
    slides,
    contacts,
    tasks,
    forms,
    comments,
    server,
  ] = await Promise.all([
    import('../src/tools/gmail-handlers.js'),
    import('../src/tools/calendar-handlers.js'),
    import('../src/tools/drive-handlers.js'),
    import('../src/tools/docs-handlers.js'),
    import('../src/tools/sheets-handlers.js'),
    import('../src/tools/slides-handlers.js'),
    import('../src/tools/contacts-handlers.js'),
    import('../src/tools/tasks-handlers.js'),
    import('../src/tools/forms-handlers.js'),
    import('../src/tools/comments-handlers.js'),
    import('../src/tools/server.js'),
  ]);

  const formatErrorResponse = (error: unknown) => (
    new server.GSuiteServer() as unknown as { formatErrorResponse(error: unknown): unknown }
  ).formatErrorResponse(error);

  return {
    ...gmail,
    ...calendar,
    ...drive,
    ...docs,
    ...sheets,
    ...slides,
    ...contacts,
    ...tasks,
    ...forms,
    ...comments,
    formatErrorResponse,
  };
}

function installHappyPathGoogleApiMocks(): void {
  mswServer.use(
    http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('pageToken') === 'page-2') {
        return HttpResponse.json({
          messages: [{ id: 'msg-2', threadId: 'thread-2' }],
          resultSizeEstimate: 2,
        });
      }
      return HttpResponse.json({
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
        nextPageToken: 'page-2',
        resultSizeEstimate: 2,
      });
    }),
    http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages/:id', ({ params }) => HttpResponse.json({
      id: params.id,
      threadId: `thread-${params.id}`,
      snippet: 'Mock email snippet',
      payload: {
        headers: [
          { name: 'From', value: 'Sender <sender@example.com>' },
          { name: 'To', value: TEST_EMAIL },
          { name: 'Subject', value: 'Mock Workspace Email' },
          { name: 'Date', value: new Date('2026-05-19T12:00:00Z').toUTCString() },
        ],
        body: { data: Buffer.from('Mock body').toString('base64url') },
      },
    })),
    http.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', () => HttpResponse.json({
      id: 'sent-msg-1',
      threadId: 'thread-sent-1',
      labelIds: ['SENT'],
    })),

    http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('pageToken') === 'calendar-page-2') {
        return HttpResponse.json({
          items: [{
            id: 'event-2',
            summary: 'Mock follow-up',
            start: { dateTime: '2026-05-19T13:00:00Z' },
            end: { dateTime: '2026-05-19T13:30:00Z' },
          }],
        });
      }
      return HttpResponse.json({
        items: [{
          id: 'event-1',
          summary: 'Mock standup',
          start: { dateTime: '2026-05-19T12:00:00Z' },
          end: { dateTime: '2026-05-19T12:30:00Z' },
        }],
        nextPageToken: 'calendar-page-2',
      });
    }),
    http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', async ({ request }) => {
      const body = await request.json() as { summary?: string };
      return HttpResponse.json({
        id: 'created-event-1',
        summary: body.summary ?? 'Created event',
        htmlLink: 'https://calendar.google.com/event?eid=created-event-1',
        start: { dateTime: '2026-05-19T14:00:00Z' },
        end: { dateTime: '2026-05-19T14:05:00Z' },
      });
    }),

    http.get('https://www.googleapis.com/drive/v3/files', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('pageToken') === 'drive-page-2') {
        return HttpResponse.json({
          files: [{ id: 'drive-file-2', name: 'Second Mock File', mimeType: 'text/plain' }],
        });
      }
      return HttpResponse.json({
        files: [{ id: 'drive-file-1', name: 'Mock Doc', mimeType: 'application/vnd.google-apps.document' }],
        nextPageToken: 'drive-page-2',
      });
    }),
    http.post('https://www.googleapis.com/upload/drive/v3/files', () => HttpResponse.json({
      id: 'uploaded-drive-file-1',
      name: 'mock-upload.txt',
      mimeType: 'text/plain',
      webViewLink: 'https://drive.google.com/file/d/uploaded-drive-file-1/view',
    })),

    http.get('https://docs.googleapis.com/v1/documents/doc-1', () => HttpResponse.json(mockDocument())),
    http.post('https://docs.googleapis.com/v1/documents/doc-1:batchUpdate', () => HttpResponse.json({
      documentId: 'doc-1',
      replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
    })),

    http.get('https://sheets.googleapis.com/v4/spreadsheets/sheet-1', () => HttpResponse.json(mockSpreadsheet())),
    http.get(/https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-1\/values\/.+/, () => HttpResponse.json({
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [['Name', 'Score'], ['Ada', '99']],
    })),
    http.put(/https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-1\/values\/.+/, async ({ request }) => {
      const body = await request.json() as { values?: unknown[] };
      return HttpResponse.json({
        spreadsheetId: 'sheet-1',
        updatedRange: 'Sheet1!A1:B1',
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: Array.isArray(body.values?.[0]) ? body.values[0].length : 2,
      });
    }),

    http.get(`https://slides.googleapis.com/v1/presentations/${VALID_SLIDES_ID}`, () => HttpResponse.json(mockPresentation())),
    http.post(`https://slides.googleapis.com/v1/presentations/${VALID_SLIDES_ID}:batchUpdate`, () => HttpResponse.json({
      presentationId: VALID_SLIDES_ID,
      replies: [{ createSlide: { objectId: 'slide-created-1' } }],
    })),

    http.get('https://people.googleapis.com/v1/people/me/connections', () => HttpResponse.json({
      connections: [{
        resourceName: 'people/contact-1',
        names: [{ displayName: 'Mock Contact' }],
        emailAddresses: [{ value: 'contact@example.com' }],
      }],
      totalPeople: 1,
    })),

    http.get(/https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/(%40default|@default)\/tasks/, () => HttpResponse.json({
      items: [{ id: 'task-1', title: 'Mock Task', status: 'needsAction' }],
    })),
    http.post(/https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/(%40default|@default)\/tasks/, async ({ request }) => {
      const body = await request.json() as { title?: string };
      return HttpResponse.json({ id: 'task-created-1', title: body.title ?? 'Created task', status: 'needsAction' });
    }),

    http.get('https://forms.googleapis.com/v1/forms/form-1/responses', () => HttpResponse.json({
      responses: [{ responseId: 'response-1', createTime: '2026-05-19T12:00:00Z', answers: {} }],
    })),

    http.get('https://www.googleapis.com/drive/v3/files/file-1/comments', () => HttpResponse.json({
      comments: [{ id: 'comment-1', content: 'Looks good', resolved: false }],
    })),
    http.post('https://www.googleapis.com/drive/v3/files/file-1/comments', async ({ request }) => {
      const body = await request.json() as { content?: string };
      return HttpResponse.json({ id: 'comment-created-1', content: body.content ?? 'Created comment', resolved: false });
    }),
  );
}

function mockDocument() {
  return {
    documentId: 'doc-1',
    title: 'Mock Document',
    body: {
      content: [
        { startIndex: 1, endIndex: 1, sectionBreak: { sectionStyle: {} } },
        {
          startIndex: 1,
          endIndex: 25,
          paragraph: {
            elements: [{ startIndex: 1, endIndex: 25, textRun: { content: 'Hello nested document\n' } }],
          },
        },
      ],
    },
  };
}

function mockSpreadsheet() {
  return {
    spreadsheetId: 'sheet-1',
    properties: { title: 'Mock Spreadsheet' },
    sheets: [{
      properties: {
        sheetId: 0,
        title: 'Sheet1',
        gridProperties: { rowCount: 20, columnCount: 10 },
      },
      data: [{
        rowData: [{
          values: [{ formattedValue: 'Name' }, { formattedValue: 'Score' }],
        }],
      }],
    }],
  };
}

function mockPresentation() {
  return {
    presentationId: VALID_SLIDES_ID,
    title: 'Mock Presentation',
    slides: [{
      objectId: 'slide-1',
      pageElements: [{
        objectId: 'text-1',
        shape: {
          text: {
            textElements: [{ textRun: { content: 'Mock slide text\n' } }],
          },
        },
      }],
    }],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('Google Workspace mock API request coverage', () => {
  it('keeps every MSW handler URL represented in the generated request manifest', () => {
    for (const mockedEndpoint of mockedEndpoints) {
      expect(
        manifest.some(row => row.method === mockedEndpoint.method && row.path === mockedEndpoint.path),
        `${mockedEndpoint.method} ${mockedEndpoint.path}`,
      ).toBe(true);
    }
  });
});

describe('Google Workspace mock API happy paths', () => {
  it('covers Gmail read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const search = await handlers.handleSearchWorkspaceEmails({
      query: 'subject:Mock',
      max_results: 1,
      return_json: true,
    });
    expect(JSON.stringify(search)).toContain('msg-1');

    const send = await handlers.handleSendWorkspaceEmail({
      to: ['recipient@example.com'],
      subject: 'Mock send',
      body: 'Hello from MSW',
    });
    expect(JSON.stringify(send)).toContain('sent-msg-1');
  });

  it('covers Calendar read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const events = await handlers.handleListWorkspaceCalendarEvents({
      calendar_id: 'primary',
      max_results: 1,
      return_json: true,
    });
    expect(JSON.stringify(events)).toContain('event-1');

    const created = await handlers.handleCreateWorkspaceCalendarEvent({
      calendar_id: 'primary',
      summary: 'Mock created event',
      start: { dateTime: '2026-05-19T14:00:00Z' },
      end: { dateTime: '2026-05-19T14:05:00Z' },
    });
    expect(JSON.stringify(created)).toContain('created-event-1');
  });

  it('surfaces operational Calendar/Contacts failures as InternalError with the real cause (not InvalidParams)', async () => {
    // Regression guard for the error-opacity follow-up: an operational Google API failure
    // must reach the user via toMcpError (InternalError + real message), NOT be re-thrown as
    // InvalidParams — which the Rebel host re-labels ARG_VALIDATION_FAILED and hides behind
    // generic "needs a bit more from you" copy. See docs/plans/260713_gws-error-opacity-followups.
    installHappyPathGoogleApiMocks();
    mswServer.use(
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json({ error: { code: 500, message: 'Backend Error' } }, { status: 500 })),
      http.get('https://people.googleapis.com/v1/people/me/connections', () =>
        HttpResponse.json({ error: { code: 500, message: 'Backend Error' } }, { status: 500 })),
    );
    const handlers = await loadHandlers();

    const createEvent = handlers.handleCreateWorkspaceCalendarEvent({
      calendar_id: 'primary',
      summary: 'Doomed event',
      start: { dateTime: '2026-05-19T14:00:00Z' },
      end: { dateTime: '2026-05-19T14:05:00Z' },
    });
    await expect(createEvent).rejects.toBeInstanceOf(McpError);
    await createEvent.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.code).not.toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain('Failed to create calendar event');
    });

    const getContacts = handlers.handleGetContacts({ person_fields: 'names,emailAddresses', page_size: 5 });
    await expect(getContacts).rejects.toBeInstanceOf(McpError);
    await getContacts.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.message).toContain('Failed to get contacts');
    });
  });

  it('covers Drive read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const files = await handlers.handleListDriveFiles({ options: { pageSize: 1 }, return_json: true });
    expect(JSON.stringify(files)).toContain('drive-file-1');

    const upload = await handlers.handleUploadDriveFile({
      options: { name: 'mock-upload.txt', content: 'hello', mimeType: 'text/plain' },
    });
    expect(JSON.stringify(upload)).toContain('uploaded-drive-file-1');
  });

  it('covers Docs read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const doc = await handlers.handleReadDocument({ document_id: 'doc-1', return_json: true });
    expect(JSON.stringify(doc)).toContain('Mock Document');

    const replace = await handlers.handleFindAndReplace({
      document_id: 'doc-1',
      find_text: 'Hello',
      replace_text: 'Hi',
    });
    expect(String(replace)).toContain('Replaced 2');
  });

  it('covers Sheets read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const sheet = await handlers.handleReadSpreadsheet({
      spreadsheet_id: 'sheet-1',
      range: 'Sheet1!A1:B2',
      return_json: true,
      anchor_mode: 'never',
    });
    expect(JSON.stringify(sheet)).toContain('Mock Spreadsheet');

    const update = await handlers.handleUpdateValues({
      spreadsheet_id: 'sheet-1',
      range: 'Sheet1!A1:B1',
      values: [['Name', 'Score']],
      overwrite_formulas: true,
      value_input_option: 'RAW',
    });
    expect(String(update)).toContain('Updated cells: 2');
  });

  it('covers Slides read and write tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const presentation = await handlers.handleReadPresentation({ presentation_id: VALID_SLIDES_ID, return_json: true });
    expect(JSON.stringify(presentation)).toContain('Mock Presentation');

    const batch = await handlers.handleBatchUpdatePresentation({
      presentation_id: VALID_SLIDES_ID,
      requests: [{ createSlide: { objectId: 'slide-created-1' } }],
    });
    expect(String(batch)).toContain('Changes applied: 1');
  });

  it('covers Contacts, Tasks, Forms, and Comments tools', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    const contacts = await handlers.handleGetContacts({ person_fields: 'names,emailAddresses', page_size: 5 });
    expect(JSON.stringify(contacts)).toContain('Mock Contact');

    const tasks = await handlers.handleListTasks({ task_list_id: '@default', max_results: 5 });
    expect(JSON.stringify(tasks)).toContain('Mock Task');

    const createdTask = await handlers.handleCreateTask({ task_list_id: '@default', title: 'Created task' });
    expect(JSON.stringify(createdTask)).toContain('task-created-1');

    const forms = await handlers.handleListFormResponses({ form_id: 'form-1', max_results: 5 });
    expect(JSON.stringify(forms)).toContain('response-1');

    const comments = await handlers.handleListComments({ file_id: 'file-1', page_size: 5 });
    expect(String(comments)).toContain('Looks good');

    const createdComment = await handlers.handleCreateComment({ file_id: 'file-1', content: 'Created comment' });
    expect(JSON.stringify(createdComment)).toContain('comment-created-1');
  });
});

describe('Google Workspace mock API shared-drive support', () => {
  it('lists shared drives and paginates via drives.list', async () => {
    mswServer.use(
      http.get('https://www.googleapis.com/drive/v3/drives', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('pageToken') === 'drives-page-2') {
          return HttpResponse.json({
            drives: [{ id: 'shared-drive-2', name: 'Second Shared Drive', createdTime: '2026-02-01T00:00:00Z' }],
          });
        }
        return HttpResponse.json({
          drives: [{ id: 'shared-drive-1', name: 'Mock Shared Drive', createdTime: '2026-01-01T00:00:00Z' }],
          nextPageToken: 'drives-page-2',
        });
      }),
    );
    const handlers = await loadHandlers();

    const drives = await handlers.handleListSharedDrives({});
    expect(String(drives)).toContain('Mock Shared Drive');
    expect(String(drives)).toContain('shared-drive-1');

    const secondPage = await handlers.handleListSharedDrives({ page_token: 'drives-page-2', return_json: true });
    expect(JSON.stringify(secondPage)).toContain('shared-drive-2');
  });

  it('forces corpora=drive when driveId is set and passes corpora=allDrives through untouched', async () => {
    const capturedQueries: Array<Record<string, string | null>> = [];
    mswServer.use(
      http.get('https://www.googleapis.com/drive/v3/files', ({ request }) => {
        const url = new URL(request.url);
        capturedQueries.push({
          corpora: url.searchParams.get('corpora'),
          driveId: url.searchParams.get('driveId'),
          supportsAllDrives: url.searchParams.get('supportsAllDrives'),
        });
        return HttpResponse.json({
          files: [{ id: 'drive-file-1', name: 'Mock Doc', mimeType: 'text/plain' }],
        });
      }),
    );
    const handlers = await loadHandlers();

    // Caller-supplied corpora is deliberately overridden: Google 400s on driveId without corpora='drive'.
    await handlers.handleListDriveFiles({
      options: { driveId: 'shared-drive-1', corpora: 'user' },
      return_json: true,
    });
    expect(capturedQueries[0]).toEqual({
      corpora: 'drive',
      driveId: 'shared-drive-1',
      supportsAllDrives: 'true',
    });

    await handlers.handleSearchDriveFiles({
      options: { fullText: 'mock', corpora: 'allDrives' },
      return_json: true,
    });
    expect(capturedQueries[1]).toEqual({
      corpora: 'allDrives',
      driveId: null,
      supportsAllDrives: 'true',
    });
  });

});

describe('Google Workspace mock API pagination', () => {
  it('respects Gmail, Drive, and Calendar nextPageToken requests', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    await expect(handlers.handleSearchWorkspaceEmails({ query: '', max_results: 1, pageToken: 'page-2', return_json: true }))
      .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('msg-2'));
    await expect(handlers.handleListDriveFiles({ options: { pageSize: 1, pageToken: 'drive-page-2' }, return_json: true }))
      .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('drive-file-2'));
    await expect(handlers.handleListWorkspaceCalendarEvents({
      calendar_id: 'primary',
      max_results: 1,
      page_token: 'calendar-page-2',
      return_json: true,
    })).resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('event-2'));
  });
});

describe('Google Workspace mock API error handling', () => {
  it('maps 401 responses to structured auth_required when refresh is disabled', async () => {
    const handlers = await loadHandlers({ GOOGLE_WORKSPACE_DISABLE_REFRESH: '1' });
    const response = handlers.formatErrorResponse({ response: { status: 401 }, message: 'Unauthorized' });
    expect(response).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'google.connect_account' },
      setupToolName: 'authenticate_workspace_account',
    });
  });

  it('returns insufficient-scope recovery guidance for 403 errors', async () => {
    const handlers = await loadHandlers();
    const response = handlers.formatErrorResponse({ response: { status: 403 }, message: 'Forbidden' });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).toContain('insufficient');
  });

  it('returns back-off recovery guidance for 429 errors', async () => {
    const handlers = await loadHandlers();
    const response = handlers.formatErrorResponse({ response: { status: 429 }, message: 'Rate limit exceeded' });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response).toLowerCase()).toContain('back off');
  });

  it('returns retry recovery guidance for 500 errors', async () => {
    const handlers = await loadHandlers();
    const response = handlers.formatErrorResponse({ response: { status: 500 }, message: 'Backend error' });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response).toLowerCase()).toContain('retry');
  });
});

describe('Google Workspace mock API input validation and edge cases', () => {
  it('rejects invalid email format with descriptive recovery guidance', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    await expect(handlers.handleSearchWorkspaceEmails({ email: 'not-an-email', query: '' })).rejects.toSatisfy((error: unknown) => {
      const response = handlers.formatErrorResponse(error);
      expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(response)).toContain('Invalid email');
      return true;
    });
  });

  it('rejects missing required fields with action_required and next_step', async () => {
    const handlers = await loadHandlers();

    await expect(handlers.handleUploadDriveFile({ options: { content: 'missing name' } })).rejects.toSatisfy((error: unknown) => {
      const response = handlers.formatErrorResponse(error);
      expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(response)).toContain('options.name');
      expect(JSON.stringify(response)).toContain('next_step');
      return true;
    });
  });

  it('rejects oversized attachments before sending', async () => {
    installHappyPathGoogleApiMocks();
    const handlers = await loadHandlers();

    await expect(handlers.handleSendWorkspaceEmail({
      to: ['recipient@example.com'],
      subject: 'Large attachment',
      body: 'Attachment test',
      attachments: [{
        name: 'too-large.bin',
        mimeType: 'application/octet-stream',
        size: 26 * 1024 * 1024,
        content: Buffer.from('x').toString('base64'),
      }],
    })).rejects.toSatisfy((error: unknown) => {
      const response = handlers.formatErrorResponse(error);
      expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(response)).toContain('exceeds maximum');
      return true;
    });
  });

  it('handles empty lists and deeply nested document content', async () => {
    mswServer.use(
      http.get('https://www.googleapis.com/drive/v3/files', () => HttpResponse.json({ files: [] })),
      http.get('https://docs.googleapis.com/v1/documents/deep-doc', () => HttpResponse.json({
        ...mockDocument(),
        documentId: 'deep-doc',
        body: {
          content: [{
            paragraph: {
              elements: [{
                textRun: { content: 'Level 1 > Level 2 > Level 3 > deeply nested note\n' },
              }],
            },
          }],
        },
      })),
    );
    const handlers = await loadHandlers();

    await expect(handlers.handleListDriveFiles({ options: { pageSize: 10 } })).resolves.toContain('No files found');
    await expect(handlers.handleReadDocument({ document_id: 'deep-doc' })).resolves.toContain('deeply nested note');
  });
});
