import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';
const SPACE_NAME = 'spaces/AAAAmockspace';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
].join(' ');

let cleanupDir: string | undefined;

function createWorkspaceEnv(): void {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-chat-'));
  const credentialsPath = path.join(cleanupDir, 'credentials');
  fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cleanupDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Chat test user' }],
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
  vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
}

async function loadHandlers() {
  createWorkspaceEnv();
  vi.resetModules();
  const accounts = await import('../src/modules/accounts/index.js');
  await accounts.initializeAccountModule();
  const handlers = await import('../src/tools/chat-handlers.js');
  const { chatTools } = await import('../src/tools/definitions/chat.js');
  return { ...handlers, chatTools };
}

function installHappyPathChatMocks(): void {
  mswServer.use(
    http.get('https://chat.googleapis.com/v1/spaces', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('pageToken') === 'spaces-page-2') {
        return HttpResponse.json({
          spaces: [{ name: 'spaces/BBBpage2', displayName: 'Second Space', spaceType: 'SPACE' }],
        });
      }
      return HttpResponse.json({
        spaces: [
          { name: SPACE_NAME, displayName: 'Mock Space', spaceType: 'SPACE' },
          { name: 'spaces/CCCdm', displayName: '', spaceType: 'DIRECT_MESSAGE' },
        ],
        nextPageToken: 'spaces-page-2',
      });
    }),
    http.get(`https://chat.googleapis.com/v1/${SPACE_NAME}/messages`, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('pageToken') === 'messages-page-2') {
        return HttpResponse.json({
          messages: [{
            name: `${SPACE_NAME}/messages/msg-2`,
            text: 'Older mock message',
            createTime: '2026-05-19T11:00:00Z',
            sender: { name: 'users/123', displayName: 'Mock Sender', type: 'HUMAN' },
          }],
        });
      }
      return HttpResponse.json({
        messages: [{
          name: `${SPACE_NAME}/messages/msg-1`,
          text: 'Hello from mock chat',
          createTime: '2026-05-19T12:00:00Z',
          sender: { name: 'users/123', displayName: 'Mock Sender', type: 'HUMAN' },
          thread: { name: `${SPACE_NAME}/threads/thread-1` },
        }],
        nextPageToken: 'messages-page-2',
      });
    }),
    http.post(`https://chat.googleapis.com/v1/${SPACE_NAME}/messages`, async ({ request }) => {
      const body = await request.json() as { text?: string };
      return HttpResponse.json({
        name: `${SPACE_NAME}/messages/msg-created-1`,
        text: body.text ?? '',
        createTime: '2026-05-19T13:00:00Z',
        sender: { name: 'users/me', displayName: 'Mock User', type: 'HUMAN' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('Chat tool definitions', () => {
  it('exposes the three chat tools with the expected annotations', async () => {
    const { chatTools } = await loadHandlers();

    const names = chatTools.map(tool => tool.name);
    expect(names).toEqual(['list_chat_spaces', 'list_chat_messages', 'send_chat_message']);

    const byName = new Map(chatTools.map(tool => [tool.name, tool]));
    expect(byName.get('list_chat_spaces')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('list_chat_messages')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('send_chat_message')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('list_chat_messages')?.inputSchema.required).toContain('space');
    expect(byName.get('send_chat_message')?.inputSchema.required).toEqual(
      expect.arrayContaining(['space', 'text']),
    );
    for (const tool of chatTools) {
      expect(tool.category).toBe('Chat');
    }
  });
});

describe('Chat handlers happy paths', () => {
  it('lists spaces with untrusted-content envelopes on space data', async () => {
    installHappyPathChatMocks();
    const handlers = await loadHandlers();

    const result = await handlers.handleListChatSpaces({ page_size: 10 });
    expect(result.spaces).toHaveLength(2);
    // wrapUntrustedJsonStrings envelopes every string field, including the page token
    expect(result.nextPageToken).toContain('spaces-page-2');
    expect(result.spaces[0].name).toContain(SPACE_NAME);
    expect(result.spaces[0].displayName).toBe(
      '<untrusted-content source="google-workspace:chat:spaces">Mock Space</untrusted-content>',
    );
  });

  it('paginates spaces via page_token', async () => {
    installHappyPathChatMocks();
    const handlers = await loadHandlers();

    const secondPage = await handlers.handleListChatSpaces({ page_token: 'spaces-page-2' });
    expect(JSON.stringify(secondPage)).toContain('spaces/BBBpage2');
  });

  it('caps page_size at 100', async () => {
    let capturedPageSize: string | null = null;
    mswServer.use(
      http.get('https://chat.googleapis.com/v1/spaces', ({ request }) => {
        capturedPageSize = new URL(request.url).searchParams.get('pageSize');
        return HttpResponse.json({ spaces: [] });
      }),
    );
    const handlers = await loadHandlers();

    await handlers.handleListChatSpaces({ page_size: 500 });
    expect(capturedPageSize).toBe('100');
  });

  it('lists messages with untrusted-content envelopes on text and sender names', async () => {
    installHappyPathChatMocks();
    const handlers = await loadHandlers();

    const result = await handlers.handleListChatMessages({ space: SPACE_NAME, page_size: 5 });
    expect(result.messages).toHaveLength(1);
    expect(result.nextPageToken).toContain('messages-page-2');
    expect(result.messages[0].text).toBe(
      '<untrusted-content source="google-workspace:chat:messages">Hello from mock chat</untrusted-content>',
    );
    expect(result.messages[0].sender?.displayName).toBe(
      '<untrusted-content source="google-workspace:chat:messages">Mock Sender</untrusted-content>',
    );

    const secondPage = await handlers.handleListChatMessages({
      space: SPACE_NAME,
      page_token: 'messages-page-2',
    });
    expect(JSON.stringify(secondPage)).toContain('msg-2');
  });

  it('sends a message and returns the created message resource', async () => {
    installHappyPathChatMocks();
    const handlers = await loadHandlers();

    const result = await handlers.handleSendChatMessage({
      space: SPACE_NAME,
      text: 'Test outgoing message',
    });
    expect(result.name).toContain('msg-created-1');
    expect(JSON.stringify(result)).toContain('Test outgoing message');
  });
});

describe('Chat handlers error handling', () => {
  it('surfaces a 403 from spaces.list as InternalError with the real cause', async () => {
    mswServer.use(
      http.get('https://chat.googleapis.com/v1/spaces', () =>
        HttpResponse.json({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }, { status: 403 })),
    );
    const handlers = await loadHandlers();

    const call = handlers.handleListChatSpaces({});
    await expect(call).rejects.toBeInstanceOf(McpError);
    await call.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.code).not.toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain('Failed to list chat spaces');
    });
  });

  it('surfaces a 500 from messages.create as InternalError with the real cause', async () => {
    mswServer.use(
      http.post(`https://chat.googleapis.com/v1/${SPACE_NAME}/messages`, () =>
        HttpResponse.json({ error: { code: 500, message: 'Backend Error' } }, { status: 500 })),
    );
    const handlers = await loadHandlers();

    const call = handlers.handleSendChatMessage({ space: SPACE_NAME, text: 'Doomed message' });
    await expect(call).rejects.toBeInstanceOf(McpError);
    await call.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.message).toContain('Failed to send chat message');
    });
  });

  it('rejects missing required params with InvalidParams', async () => {
    const handlers = await loadHandlers();

    const listMessages = handlers.handleListChatMessages({});
    await expect(listMessages).rejects.toBeInstanceOf(McpError);
    await listMessages.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain('space');
    });

    const sendMessage = handlers.handleSendChatMessage({ space: SPACE_NAME });
    await expect(sendMessage).rejects.toBeInstanceOf(McpError);
    await sendMessage.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain('text');
    });
  });

  it('rejects a space parameter that is not a space resource name', async () => {
    const handlers = await loadHandlers();

    const call = handlers.handleListChatMessages({ space: 'not-a-space' });
    await expect(call).rejects.toBeInstanceOf(McpError);
    await call.catch((err: McpError) => {
      expect(err.code).toBe(ErrorCode.InvalidParams);
    });
  });
});
