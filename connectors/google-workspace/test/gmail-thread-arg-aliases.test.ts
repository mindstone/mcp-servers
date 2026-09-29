/**
 * Gmail thread/search argument-name acceptance (W-rebel-209).
 *
 * Models hold a *message* id from search results and ask for "the thread", or
 * use camelCase / synonym names. SuperMCP's strict schema gate rejects any key
 * the exported inputSchema does not declare (-33003 "Unknown fields: messageId")
 * BEFORE the handler runs, so the aliases must be ADVERTISED in the schema, not
 * only tolerated by the handler. This test pins both halves:
 *
 *  1. Schema gate: a strict check (declared keys only + `required`) admits each
 *     sighted payload and still rejects a key with no known meaning.
 *  2. Handler: message_id / messageId / id resolve to the thread via one extra
 *     message lookup; threadId is an exact alias of thread_id; limit and
 *     max_messages map to max_results on search; a missing message id is a
 *     clear not-found error, not a validation error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { handleGetWorkspaceEmailThread, handleSearchWorkspaceEmails } from '../src/tools/gmail-handlers.js';
import { gmailTools } from '../src/tools/definitions/gmail.js';

const { getMessageMock, getThreadMock, getEmailsMock } = vi.hoisted(() => ({
  getMessageMock: vi.fn(),
  getThreadMock: vi.fn(),
  getEmailsMock: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/modules/gmail/index.js', () => ({
  getGmailService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    getMessage: getMessageMock,
    getThread: getThreadMock,
    getEmails: getEmailsMock,
  }),
}));

vi.mock('../src/modules/accounts/index.js', () => ({
  getAccountManager: () => ({
    withTokenRenewal: (_email: string, fn: () => Promise<unknown>) => fn(),
  }),
  resolveEmail: vi.fn().mockResolvedValue('jane@example.com'),
  validateEmail: vi.fn(),
}));

vi.mock('../src/modules/attachments/service.js', () => ({
  AttachmentService: { getInstance: vi.fn(() => ({})) },
}));

const THREAD = {
  threadId: 'thread-9',
  messagesCount: 1,
  messages: [{ id: 'msg-2', from: 'a@example.com', to: ['b@example.com'], date: 'Mon, 1 Jan 2026 10:00:00 +0000', subject: 'Hi', body: { text: 'hello' } }],
};

function schemaOf(name: string) {
  const tool = gmailTools.find(t => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
}

/** Mirrors the SuperMCP gate: additionalProperties:false + required. */
function strictGate(schema: ReturnType<typeof schemaOf>, args: Record<string, unknown>) {
  const unknown = Object.keys(args).filter(k => !(k in schema.properties));
  const missing = (schema.required ?? []).filter(k => !(k in args));
  return { unknown, missing };
}

describe('schema gate admits the sighted argument names', () => {
  const thread = schemaOf('get_workspace_email_thread');
  const search = schemaOf('search_workspace_emails');

  it.each([
    ['thread_id', { thread_id: 't1' }],
    ['threadId', { threadId: 't1' }],
    ['message_id', { message_id: 'm1' }],
    ['messageId', { messageId: 'm1' }],
    ['id', { id: 'm1' }],
  ])('get_workspace_email_thread accepts %s alone', (_n, args) => {
    expect(strictGate(thread, args)).toEqual({ unknown: [], missing: [] });
  });

  it('get_workspace_email_thread still rejects a key with no known meaning', () => {
    expect(strictGate(thread, { thread_id: 't1', bogus: 1 }).unknown).toEqual(['bogus']);
  });

  it.each([['limit'], ['max_messages'], ['max_results']])('search_workspace_emails accepts %s', key => {
    expect(strictGate(search, { query: 'x', [key]: 5 }).unknown).toEqual([]);
  });

  it('search_workspace_emails still rejects a key with no known meaning', () => {
    expect(strictGate(search, { query: 'x', from_me: true }).unknown).toEqual(['from_me']);
  });
});

describe('get_workspace_email_thread handler', () => {
  beforeEach(() => {
    getMessageMock.mockReset();
    getThreadMock.mockReset();
    getThreadMock.mockResolvedValue(THREAD);
  });

  it.each([
    ['message_id', { message_id: 'msg-2' }],
    ['messageId', { messageId: 'msg-2' }],
    ['id', { id: 'msg-2' }],
  ])('resolves the thread from %s', async (_n, args) => {
    getMessageMock.mockResolvedValue({ id: 'msg-2', threadId: 'thread-9' });

    const result = await handleGetWorkspaceEmailThread(args as never);

    expect(getMessageMock).toHaveBeenCalledWith('jane@example.com', 'msg-2');
    expect(getThreadMock.mock.calls[0][1]).toBe('thread-9');
    expect(JSON.stringify(result)).toContain('thread-9');
  });

  it('threadId behaves exactly like thread_id and needs no message lookup', async () => {
    await handleGetWorkspaceEmailThread({ threadId: 'thread-9' });

    expect(getMessageMock).not.toHaveBeenCalled();
    expect(getThreadMock.mock.calls[0][1]).toBe('thread-9');
  });

  it('an explicit thread_id wins over a message id', async () => {
    await handleGetWorkspaceEmailThread({ thread_id: 'thread-9', message_id: 'other' } as never);

    expect(getMessageMock).not.toHaveBeenCalled();
    expect(getThreadMock.mock.calls[0][1]).toBe('thread-9');
  });

  it('a message id that does not exist is a not-found error, not a validation error', async () => {
    getMessageMock.mockResolvedValue(null);

    const err = await handleGetWorkspaceEmailThread({ message_id: 'nope' } as never).catch(e => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).not.toBe(ErrorCode.InvalidParams);
    expect(err.message).toMatch(/not found/i);
    expect(err.message).toContain('nope');
    expect(getThreadMock).not.toHaveBeenCalled();
  });

  it('naming no identifier at all is still a validation error that lists the accepted names', async () => {
    const err = await handleGetWorkspaceEmailThread({} as never).catch(e => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('thread_id');
    expect(err.message).toContain('message_id');
  });
});

describe('search_workspace_emails handler', () => {
  beforeEach(() => {
    getEmailsMock.mockReset();
    getEmailsMock.mockResolvedValue({ emails: [], resultSummary: { total: 0, returned: 0, hasMore: false } });
  });

  it.each([
    ['limit', { limit: 7 }],
    ['max_messages', { max_messages: 7 }],
    ['max_results', { max_results: 7 }],
  ])('maps %s to max_results', async (_n, args) => {
    await handleSearchWorkspaceEmails({ query: 'x', ...args });

    expect(getEmailsMock.mock.calls[0][0].options.maxResults).toBe(7);
  });

  it('max_results wins when several are given', async () => {
    await handleSearchWorkspaceEmails({ query: 'x', max_results: 3, limit: 9 });

    expect(getEmailsMock.mock.calls[0][0].options.maxResults).toBe(3);
  });

  it('shows the thread_id of each hit under the name the thread tool takes', async () => {
    getEmailsMock.mockResolvedValue({
      emails: [{ id: 'msg-2', threadId: 'thread-9', from: 'a@example.com', to: 'b@example.com', subject: 'Hi', date: 'Mon, 1 Jan 2026' }],
      resultSummary: { total: 1, returned: 1, hasMore: false },
    });

    const result = await handleSearchWorkspaceEmails({ query: 'x' });

    expect(JSON.stringify(result)).toMatch(/thread_id: thread-9/);
  });
});
