/**
 * Reply-threading observability tests.
 *
 * `resolveReplyThreading` used to degrade to a bare console.warn + empty
 * headers when the original message could not be fetched — the reply still
 * went out, but unthreaded and invisible: nothing in the result, nothing
 * structured for the host. Contract under test:
 *
 * 1. Happy path unchanged: threadId / In-Reply-To / References still resolve
 *    from the original message and no warning is attached.
 * 2. Degraded path (fetch returns nothing OR throws): the reply still sends,
 *    but the outcome is observable — a structured logger.warn AND an additive
 *    `warnings` entry in the tool result (send + draft surfaces).
 * 3. No reply_to_message_id → no threading lookup, no warnings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSendWorkspaceEmail, handleManageWorkspaceDraft } from '../src/tools/gmail-handlers.js';
import logger from '../src/utils/logger.js';

const { manageDraftMock, getMessageMock, sendEmailMock } = vi.hoisted(() => ({
  manageDraftMock: vi.fn(),
  getMessageMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/modules/gmail/index.js', () => ({
  getGmailService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    manageDraft: manageDraftMock,
    getMessage: getMessageMock,
    sendEmail: sendEmailMock,
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

const ORIGINAL_MESSAGE_ID = 'msg-original-1';
const ORIGINAL_THREAD_ID = 'thread-original-9';
const ORIGINAL_MESSAGE_ID_HEADER = '<original-1@example.com>';

const originalMessage = {
  id: ORIGINAL_MESSAGE_ID,
  threadId: ORIGINAL_THREAD_ID,
  headers: [
    { name: 'Message-ID', value: ORIGINAL_MESSAGE_ID_HEADER },
    { name: 'References', value: '<earlier@example.com>' },
  ],
};

const SEND_PARAMS = {
  to: ['bob@example.com'],
  subject: 'Re: quarterly numbers',
  body: 'Updated numbers attached.',
  replyToMessageId: ORIGINAL_MESSAGE_ID,
};

const sendResult = { messageId: 'sent-1', threadId: 'thread-new' };

function parseSendResult(result: { content: Array<{ text: string }>; structuredContent: unknown }): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

describe('send_workspace_email reply threading', () => {
  beforeEach(() => {
    getMessageMock.mockReset();
    sendEmailMock.mockReset();
    vi.mocked(logger.warn).mockClear();
    sendEmailMock.mockResolvedValue(sendResult);
  });

  it('threads the reply from the original message (happy path unchanged)', async () => {
    getMessageMock.mockResolvedValue(originalMessage);

    const result = await handleSendWorkspaceEmail(SEND_PARAMS);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      threadId: ORIGINAL_THREAD_ID,
      inReplyTo: ORIGINAL_MESSAGE_ID_HEADER,
      references: ['<earlier@example.com>', ORIGINAL_MESSAGE_ID_HEADER],
    });
    const payload = parseSendResult(result) as { warnings?: unknown };
    expect(payload.warnings).toBeUndefined();
    expect(result.structuredContent).toEqual(sendResult);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('still sends — visibly unthreaded — when the original message is not found', async () => {
    getMessageMock.mockResolvedValue(null);

    const result = await handleSendWorkspaceEmail(SEND_PARAMS);

    // The reply keeps working: the send happens, without threading headers.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      threadId: undefined,
      inReplyTo: undefined,
      references: undefined,
    });
    // But the degraded outcome is observable: structured warn + result signal.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining(ORIGINAL_MESSAGE_ID),
    );
    const payload = parseSendResult(result) as {
      warnings: Array<{ code: string; message: string }>;
    };
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0].code).toBe('reply_threading_degraded');
    expect(payload.warnings[0].message).toContain(ORIGINAL_MESSAGE_ID);
    expect(result.structuredContent).toMatchObject({
      warnings: [{ code: 'reply_threading_degraded' }],
    });
  });

  it('still sends — visibly unthreaded — when the original-message fetch throws', async () => {
    getMessageMock.mockRejectedValue(new Error('backend error'));

    const result = await handleSendWorkspaceEmail(SEND_PARAMS);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].threadId).toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Reply threading degraded'),
      'backend error',
    );
    const payload = parseSendResult(result) as {
      warnings: Array<{ code: string }>;
    };
    expect(payload.warnings[0].code).toBe('reply_threading_degraded');
  });

  it('does no threading lookup when reply_to_message_id is absent', async () => {
    const { replyToMessageId: _omit, ...plainSend } = SEND_PARAMS;

    const result = await handleSendWorkspaceEmail(plainSend);

    expect(getMessageMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const payload = parseSendResult(result) as { warnings?: unknown };
    expect(payload.warnings).toBeUndefined();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

describe('draft create/update reply threading', () => {
  beforeEach(() => {
    getMessageMock.mockReset();
    manageDraftMock.mockReset();
    vi.mocked(logger.warn).mockClear();
    manageDraftMock.mockResolvedValue({ id: 'draft-1', message: { id: 'msg-1', threadId: 'thread-1' } });
  });

  it('threads the draft from the original message (happy path unchanged)', async () => {
    getMessageMock.mockResolvedValue(originalMessage);

    await handleManageWorkspaceDraft({
      action: 'create',
      data: {
        to: ['bob@example.com'],
        subject: 'Re: quarterly numbers',
        body: 'Draft reply.',
        replyToMessageId: ORIGINAL_MESSAGE_ID,
      },
    });

    expect(manageDraftMock).toHaveBeenCalledTimes(1);
    expect(manageDraftMock.mock.calls[0][0].data).toMatchObject({
      threadId: ORIGINAL_THREAD_ID,
      inReplyTo: ORIGINAL_MESSAGE_ID_HEADER,
    });
  });

  it('attaches the degraded-threading warning to the draft result when the original message is missing', async () => {
    getMessageMock.mockResolvedValue(null);

    const result = (await handleManageWorkspaceDraft({
      action: 'create',
      data: {
        to: ['bob@example.com'],
        subject: 'Re: quarterly numbers',
        body: 'Draft reply.',
        replyToMessageId: ORIGINAL_MESSAGE_ID,
      },
    })) as { warnings: Array<{ code: string; message: string }> };

    // Draft still created (unthreaded), but visibly so.
    expect(manageDraftMock).toHaveBeenCalledTimes(1);
    expect(manageDraftMock.mock.calls[0][0].data.threadId).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('reply_threading_degraded');
    expect(result.warnings[0].message).toContain(ORIGINAL_MESSAGE_ID);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});
