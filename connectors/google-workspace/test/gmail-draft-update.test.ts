import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { DraftService } from '../src/modules/gmail/services/draft.js';
import type { GmailAttachmentService } from '../src/modules/gmail/services/attachment.js';
import { GmailError } from '../src/modules/gmail/types.js';
import { handleManageWorkspaceDraft } from '../src/tools/gmail-handlers.js';

const { manageDraftMock } = vi.hoisted(() => ({ manageDraftMock: vi.fn() }));

vi.mock('../src/utils/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/modules/gmail/index.js', () => ({
  getGmailService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    manageDraft: manageDraftMock,
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

type ManageDraftHandlerParams = Parameters<typeof handleManageWorkspaceDraft>[0];

const draftData = {
  to: ['bob@example.com'],
  subject: 'Quarterly report',
  body: 'Draft body placeholder.',
};

const apiDraft = {
  id: 'draft-1',
  message: { id: 'msg-1', threadId: 'thread-1', labelIds: [] },
};

const stubAttachmentService = {
  validateAttachment: vi.fn(),
  prepareAttachment: vi.fn(),
} as unknown as GmailAttachmentService;

function makeDraftService(drafts: Record<string, unknown>): DraftService {
  const service = new DraftService(stubAttachmentService);
  service.updateClient({ users: { drafts } } as unknown as gmail_v1.Gmail);
  return service;
}

describe('DraftService update/create error details and threading', () => {
  it('passes threadId to drafts.update when data.threadId is set', async () => {
    const update = vi.fn().mockResolvedValue({ data: apiDraft });
    const service = makeDraftService({ update });

    await service.updateDraft('jane@example.com', 'draft-1', {
      ...draftData,
      threadId: 'thread-123',
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      userId: 'me',
      id: 'draft-1',
      requestBody: { message: { threadId: 'thread-123' } },
    });
  });

  it('sends no threadId to drafts.update when data.threadId is absent', async () => {
    const update = vi.fn().mockResolvedValue({ data: apiDraft });
    const service = makeDraftService({ update });

    await service.updateDraft('jane@example.com', 'draft-1', draftData);

    const message = (update.mock.calls[0][0] as { requestBody: { message: { threadId?: string } } })
      .requestBody.message;
    expect(message.threadId).toBeUndefined();
  });

  it('includes the underlying message and HTTP status in GmailError.details when update fails', async () => {
    const notFound = Object.assign(new Error('Requested entity was not found.'), {
      code: 404,
      response: { status: 404 },
    });
    const update = vi.fn().mockRejectedValue(notFound);
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({
      name: 'GmailError',
      code: 'UPDATE_ERROR',
      details: 'Requested entity was not found. (status 404)',
    });
  });

  it('keeps plain message details when the update failure has no HTTP status', async () => {
    const update = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({
      code: 'UPDATE_ERROR',
      details: 'socket hang up',
    });
  });

  it('includes the HTTP status in GmailError.details when create fails', async () => {
    const rateLimited = Object.assign(new Error('Rate limit exceeded'), {
      response: { status: 429 },
    });
    const create = vi.fn().mockRejectedValue(rateLimited);
    const service = makeDraftService({ create });

    await expect(
      service.createDraft('jane@example.com', draftData)
    ).rejects.toMatchObject({
      code: 'CREATE_ERROR',
      details: 'Rate limit exceeded (status 429)',
    });
  });

  // extractHttpStatus fallbacks — each supported GaxiosError-ish shape independently (reviewer F2).
  it('reads a top-level status when response.status is absent', async () => {
    const err = Object.assign(new Error('Bad Request'), { status: 400 });
    const update = vi.fn().mockRejectedValue(err);
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({ details: 'Bad Request (status 400)' });
  });

  it('reads a numeric code when no status field is present', async () => {
    const err = Object.assign(new Error('Server error'), { code: 500 });
    const update = vi.fn().mockRejectedValue(err);
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({ details: 'Server error (status 500)' });
  });

  it('coerces a numeric-string code to a status', async () => {
    const err = Object.assign(new Error('Conflict'), { code: '409' });
    const update = vi.fn().mockRejectedValue(err);
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({ details: 'Conflict (status 409)' });
  });

  it('ignores a non-numeric string code (e.g. ENOTFOUND) and keeps the plain message', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const update = vi.fn().mockRejectedValue(err);
    const service = makeDraftService({ update });

    await expect(
      service.updateDraft('jane@example.com', 'draft-1', draftData)
    ).rejects.toMatchObject({ details: 'getaddrinfo ENOTFOUND' });
  });
});

describe('handleManageWorkspaceDraft error surfacing', () => {
  beforeEach(() => {
    manageDraftMock.mockReset();
  });

  it('propagates InvalidParams instead of re-wrapping it as InternalError (update without draftId)', async () => {
    const promise = handleManageWorkspaceDraft({ action: 'update', data: draftData });
    await expect(promise).rejects.toBeInstanceOf(McpError);
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('includes GmailError.details in the InternalError message', async () => {
    manageDraftMock.mockRejectedValue(
      new GmailError(
        'Failed to update draft',
        'UPDATE_ERROR',
        'Requested entity was not found. (status 404)'
      )
    );

    const promise = handleManageWorkspaceDraft({
      action: 'update',
      draft_id: 'draft-1',
      data: draftData,
    });
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(promise).rejects.toThrow(
      /Failed to manage draft: Failed to update draft: Requested entity was not found\. \(status 404\)/
    );
  });

  it('rejects a non-array "to" with InvalidParams on create', async () => {
    await expect(
      handleManageWorkspaceDraft({
        action: 'create',
        data: { to: 'bob@example.com', subject: 'Hi', body: 'Hello' },
      } as unknown as ManageDraftHandlerParams)
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(manageDraftMock).not.toHaveBeenCalled();
  });

  it('rejects a non-array "to" with InvalidParams on update', async () => {
    await expect(
      handleManageWorkspaceDraft({
        action: 'update',
        draft_id: 'draft-1',
        data: { to: 'bob@example.com', subject: 'Hi', body: 'Hello' },
      } as unknown as ManageDraftHandlerParams)
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(manageDraftMock).not.toHaveBeenCalled();
  });

  it('rejects a non-array "cc" with InvalidParams on create', async () => {
    await expect(
      handleManageWorkspaceDraft({
        action: 'create',
        data: { to: ['bob@example.com'], cc: 'carol@example.com', subject: 'Hi', body: 'Hello' },
      } as unknown as ManageDraftHandlerParams)
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(manageDraftMock).not.toHaveBeenCalled();
  });

  it('rejects a non-array "bcc" with InvalidParams on update', async () => {
    await expect(
      handleManageWorkspaceDraft({
        action: 'update',
        draft_id: 'draft-1',
        data: { to: ['bob@example.com'], bcc: 'carol@example.com', subject: 'Hi', body: 'Hello' },
      } as unknown as ManageDraftHandlerParams)
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(manageDraftMock).not.toHaveBeenCalled();
  });

  it('accepts an empty "to" array and empty subject/body (valid for drafts)', async () => {
    manageDraftMock.mockResolvedValue(apiDraft);

    await expect(
      handleManageWorkspaceDraft({
        action: 'create',
        data: { to: [], subject: '', body: '' },
      })
    ).resolves.toMatchObject({ id: 'draft-1' });
    expect(manageDraftMock).toHaveBeenCalledTimes(1);
  });
});
