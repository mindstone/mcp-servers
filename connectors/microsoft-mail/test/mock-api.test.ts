import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('microsoft-mail mock-API integration', () => {
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

  it('list_emails returns the formatted email list and hits the inbox endpoint', async () => {
    const result = await client.callTool('list_emails', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number; folder: string; emails: unknown[] };
    expect(json.ok).toBeUndefined();
    expect(json.folder).toBe('inbox');
    expect(json.count).toBe(2);
    const listCall = state.requests.find((r) =>
      r.pathname.includes('/me/mailFolders/inbox/messages'),
    );
    expect(listCall).toBeDefined();
    expect(listCall?.search).toMatch(/\$top=5/);
  });

  it('list_emails resolves "Sent Items" display name to sentitems well-known folder', async () => {
    await client.callTool('list_emails', { folder: 'Sent Items', top: 1 });
    const listCall = state.requests.find((r) => r.pathname.includes('/me/mailFolders/'));
    expect(listCall?.pathname).toContain('/me/mailFolders/sentitems/messages');
  });

  it('get_email returns email body content', async () => {
    const result = await client.callTool('get_email', { id: 'AAMkAGI2' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; body: string };
    expect(json.ok).toBeUndefined();
    expect(json.body).toContain('Hi');
    const getCall = state.requests.find((r) => r.pathname.includes('/me/messages/AAMkAGI2'));
    expect(getCall).toBeDefined();
  });

  it('get_email returns an error envelope when id is missing', async () => {
    const result = await client.callTool('get_email', {});
    expect(result.isError).toBe(true);
    const json = result.json as {
      ok: boolean;
      error: string;
      action_required: string;
      next_step: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.action_required).toMatch(/message ID/);
    expect(json.next_step).toBe('list_emails');
  });

  it('search_emails uses $search with the supplied query', async () => {
    const result = await client.callTool('search_emails', { query: 'project update', top: 10 });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; query: string; count: number };
    expect(json.ok).toBeUndefined();
    expect(json.query).toBe('project update');
    const call = state.requests.find((r) => /\$search=/.test(r.search));
    expect(call).toBeDefined();
    expect(decodeURIComponent(call!.search)).toContain('project update');
  });

  it('search_emails surfaces friendly guidance when query is missing', async () => {
    const result = await client.callTool('search_emails', {});
    expect(result.isError).toBe(true);
    const json = result.json as {
      ok: boolean;
      error: string;
      action_required: string;
      next_step: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
    expect(json.next_step).toBe('search_emails');
  });

  it('send_email posts to /me/sendMail with the right recipient body', async () => {
    const result = await client.callTool('send_email', {
      to: ['alice@example.com'],
      subject: 'Hi',
      body: 'Hello there',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.message).toContain('alice@example.com');
    const call = state.requests.find((r) => r.pathname.endsWith('/me/sendMail'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toMatchObject({
      message: {
        subject: 'Hi',
        toRecipients: [{ emailAddress: { address: 'alice@example.com' } }],
      },
    });
  });

  it('send_email accepts a single string in "to" and normalises it', async () => {
    await client.callTool('send_email', {
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello there',
    });
    const call = state.requests.find((r) => r.pathname.endsWith('/me/sendMail'));
    expect(call?.body).toMatchObject({
      message: {
        toRecipients: [{ emailAddress: { address: 'alice@example.com' } }],
      },
    });
  });

  it('send_email rejects calls missing the recipient or subject', async () => {
    const result = await client.callTool('send_email', {
      to: [],
      subject: '',
      body: 'x',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('send_email');
  });

  it('send_email rejects "recipient"/"recipients" aliases with explicit guidance', async () => {
    const recipientResult = await client.callTool('send_email', {
      recipient: 'alice@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(recipientResult.isError).toBe(true);
    const recipientJson = recipientResult.json as { ok: boolean; error: string; next_step: string };
    expect(recipientJson.ok).toBe(false);
    expect(recipientJson.error).toContain('"to" instead of "recipient"/"recipients"');
    expect(recipientJson.next_step).toBe('send_email');

    const recipientsResult = await client.callTool('send_email', {
      recipients: ['alice@example.com'],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(recipientsResult.isError).toBe(true);
    const recipientsJson = recipientsResult.json as { error: string };
    expect(recipientsJson.error).toContain('"to" instead of "recipient"/"recipients"');
  });

  it('send_email rejects "message"/"content"/"text" aliases with explicit guidance', async () => {
    for (const alias of ['message', 'content', 'text']) {
      const result = await client.callTool('send_email', {
        to: 'alice@example.com',
        subject: 'Hi',
        [alias]: 'Hello there',
      });
      expect(result.isError, `${alias} alias should be rejected`).toBe(true);
      const json = result.json as { ok: boolean; error: string; next_step: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('"body" instead of "message"/"content"/"text"');
      expect(json.next_step).toBe('send_email');
    }
  });

  it('create_draft posts to /me/messages with HTML detection', async () => {
    const result = await client.callTool('create_draft', {
      subject: 'Draft',
      body: '<p>Draft content</p>',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; draftId: string };
    expect(json.ok).toBeUndefined();
    expect(json.draftId).toBe('draft-1');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/messages'),
    );
    expect(call?.body).toMatchObject({
      subject: 'Draft',
      body: { contentType: 'HTML', content: '<p>Draft content</p>' },
    });
  });

  it('delete_email defaults to move-to-Deleted-Items (non-destructive trash)', async () => {
    const result = await client.callTool('delete_email', { id: 'msg-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; message: string };
    expect(json.ok).toBeUndefined();
    expect(json.message).toContain('Deleted Items');
    const moveCall = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/messages/msg-1/move'),
    );
    expect(moveCall?.body).toMatchObject({ destinationId: 'deleteditems' });
  });

  it('delete_email with permanent=true issues DELETE on the message', async () => {
    await client.callTool('delete_email', { id: 'msg-2', permanent: true });
    const deleteCall = state.requests.find(
      (r) => r.method === 'DELETE' && r.pathname.endsWith('/me/messages/msg-2'),
    );
    expect(deleteCall).toBeDefined();
  });

  it('reply_to_email posts to /reply endpoint', async () => {
    await client.callTool('reply_to_email', { id: 'msg-1', body: 'Thanks!' });
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/messages/msg-1/reply'),
    );
    expect(call?.body).toMatchObject({ comment: 'Thanks!' });
  });

  it('reply_to_email with replyAll posts to /replyAll endpoint', async () => {
    await client.callTool('reply_to_email', { id: 'msg-1', body: 'Thanks!', replyAll: true });
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/messages/msg-1/replyAll'),
    );
    expect(call).toBeDefined();
  });

  it('list_folders filters hidden folders by default', async () => {
    const result = await client.callTool('list_folders', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; count: number; folders: unknown[] };
    expect(json.ok).toBeUndefined();
    expect(json.count).toBe(2);
    const call = state.requests.find((r) => r.pathname.endsWith('/me/mailFolders'));
    expect(call?.search).toMatch(/\$filter=isHidden/);
  });

  it('move_email resolves well-known folder names', async () => {
    await client.callTool('move_email', { id: 'msg-1', destinationFolder: 'archive' });
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/messages/msg-1/move'),
    );
    expect(call?.body).toMatchObject({ destinationId: 'archive' });
  });

  it('move_email rejects calls missing id with friendly guidance', async () => {
    const result = await client.callTool('move_email', { destinationFolder: 'archive' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameters');
    expect(json.next_step).toBe('list_folders');
  });

  it('create_reply_draft hits createReply endpoint and returns draftId', async () => {
    const result = await client.callTool('create_reply_draft', {
      id: 'msg-1',
      body: 'Replying',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; draftId: string };
    expect(json.ok).toBeUndefined();
    expect(json.draftId).toBe('draft-reply-1');
    const call = state.requests.find((r) => r.pathname.endsWith('/me/messages/msg-1/createReply'));
    expect(call?.body).toMatchObject({
      message: { body: expect.objectContaining({ contentType: 'Text', content: 'Replying' }) },
    });
  });

  it('forward_email posts comment and recipients', async () => {
    await client.callTool('forward_email', {
      id: 'msg-1',
      to: 'colleague@example.com',
      comment: 'FYI',
    });
    const call = state.requests.find((r) => r.pathname.endsWith('/me/messages/msg-1/forward'));
    expect(call?.body).toMatchObject({
      comment: 'FYI',
      toRecipients: [{ emailAddress: { address: 'colleague@example.com' } }],
    });
  });
});
