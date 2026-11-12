import { describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { DraftService } from '../src/modules/gmail/services/draft.js';
import type { GmailAttachmentService } from '../src/modules/gmail/services/attachment.js';

vi.mock('../src/utils/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function apiDraft(id: string) {
  return { id, message: { id: `msg-${id}`, threadId: `thread-${id}`, labelIds: [] } };
}

function makeDraftService(drafts: Record<string, unknown>): DraftService {
  const service = new DraftService({} as GmailAttachmentService);
  service.updateClient({ users: { drafts } } as unknown as gmail_v1.Gmail);
  return service;
}

describe('DraftService.listDrafts', () => {
  it('returns every draft and no unreadable list when all reads succeed', async () => {
    const service = makeDraftService({
      list: vi.fn().mockResolvedValue({ data: { drafts: [{ id: 'd1' }, { id: 'd2' }], resultSizeEstimate: 2 } }),
      get: vi.fn().mockImplementation(({ id }: { id: string }) => Promise.resolve({ data: apiDraft(id) })),
    });
    const result = await service.listDrafts('jane@example.com');
    expect(result.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(result).not.toHaveProperty('unreadableDrafts');
  });

  it('keeps an empty mailbox distinct from a failure', async () => {
    const service = makeDraftService({
      list: vi.fn().mockResolvedValue({ data: {} }),
      get: vi.fn(),
    });
    const result = await service.listDrafts('jane@example.com');
    expect(result.drafts).toEqual([]);
    expect(result).not.toHaveProperty('unreadableDrafts');
  });

  it('keeps the drafts it read and names each one it could not read, with why', async () => {
    const rateLimited = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
    const service = makeDraftService({
      list: vi.fn().mockResolvedValue({ data: { drafts: [{ id: 'd1' }, { id: 'd2' }], resultSizeEstimate: 2 } }),
      get: vi.fn().mockImplementation(({ id }: { id: string }) =>
        id === 'd2' ? Promise.reject(rateLimited) : Promise.resolve({ data: apiDraft(id) })),
    });
    const result = await service.listDrafts('jane@example.com');
    expect(result.drafts.map((d) => d.id)).toEqual(['d1']);
    expect(result.unreadableDrafts).toEqual([{ id: 'd2', error: expect.stringContaining('status 429') }]);
    expect(result.unreadableDrafts?.[0].error).toContain('<untrusted-content');
  });

  it('says why a draft that vanished or broke could not be read', async () => {
    const service = makeDraftService({
      list: vi.fn().mockResolvedValue({ data: { drafts: [{ id: 'd1' }] } }),
      get: vi.fn().mockRejectedValue(Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } })),
    });
    const result = await service.listDrafts('jane@example.com');
    expect(result.drafts).toEqual([]);
    expect(result.unreadableDrafts).toEqual([{ id: 'd1', error: expect.stringMatching(/^Failed to get draft: <untrusted-content.*status 404/s) }]);
  });
});
