import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OutgoingGmailAttachment } from '../src/modules/gmail/types.js';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { handleSendWorkspaceEmail, handleCreateWorkspaceDraft, handleUpdateWorkspaceDraft, handleManageWorkspaceDraft } from '../src/tools/gmail-handlers.js';

const provider = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_args: { attachments?: OutgoingGmailAttachment[] }) => ({ messageId: 'message_synthetic', threadId: 'thread_synthetic' })),
  manageDraft: vi.fn(async (_args: { data?: { attachments?: OutgoingGmailAttachment[] } }) => ({ id: 'draft_synthetic' })),
}));
vi.mock('../src/modules/gmail/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/gmail/index.js')>(),
  getGmailService: () => ({ initialize: async () => undefined, ...provider }),
}));
vi.mock('../src/modules/accounts/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/accounts/index.js')>(),
  resolveEmail: async () => 'sender@example.com',
  getAccountManager: () => ({ withTokenRenewal: async (_email: string, action: () => Promise<unknown>) => action() }),
}));
let base: string;
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

it('uses each element content precedence and preserves flat versus nested draft operand locations', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-gmail-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.txt');
  const bytes = Buffer.from('Acme local attachment');
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  const attachments: OutgoingGmailAttachment[] = [
    { id: 'inline', mimeType: 'text/plain', size: 11, path: '/absent/ignored.txt', name: 'inline.txt', content: Buffer.from('Acme inline').toString('base64') },
    { id: '', name: '', mimeType: '', size: 0, path: alias, content: '' },
  ];
  const originalAttachments = attachments.map(attachment => ({ ...attachment }));
  const expectedAttachments: OutgoingGmailAttachment[] = [
    { id: 'inline', name: 'inline.txt', mimeType: 'text/plain', size: 11, content: Buffer.from('Acme inline').toString('base64') },
    { id: 'source.txt', name: 'source.txt', mimeType: 'text/plain', size: bytes.length, content: bytes.toString('base64') },
  ];
  const context = (prefix: string[]) => fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: [...prefix, 1, 'path'], rawPath: alias, canonicalPath: canonical }] } } });
  const fields = { to: ['recipient@example.com'], subject: 'Acme subject', body: 'Acme body', attachments };
  await handleSendWorkspaceEmail(fields, context(['attachments']));
  expect(provider.sendEmail).toHaveBeenCalledTimes(1);
  expect(provider.sendEmail.mock.calls[0]?.[0].attachments).toStrictEqual(expectedAttachments);
  expect(attachments).toStrictEqual(originalAttachments);
  await handleCreateWorkspaceDraft(fields, context(['attachments']));
  expect(attachments).toStrictEqual(originalAttachments);
  await handleUpdateWorkspaceDraft({ ...fields, draft_id: 'draft_synthetic' }, context(['attachments']));
  expect(attachments).toStrictEqual(originalAttachments);
  await handleManageWorkspaceDraft({ action: 'create', data: fields }, context(['data', 'attachments']));
  expect(attachments).toStrictEqual(originalAttachments);
  expect(provider.manageDraft).toHaveBeenCalledTimes(3);
  for (const [request] of provider.manageDraft.mock.calls) {
    expect(request.data?.attachments).toStrictEqual(expectedAttachments);
  }
  const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  await expect(handleSendWorkspaceEmail(fields, empty)).rejects.toThrow(/concrete operand/);
  expect(attachments).toStrictEqual(originalAttachments);
  await expect(handleCreateWorkspaceDraft(fields, empty)).rejects.toThrow(/concrete operand/);
  expect(attachments).toStrictEqual(originalAttachments);
  await expect(handleUpdateWorkspaceDraft({ ...fields, draft_id: 'draft_synthetic' }, empty)).rejects.toThrow(/concrete operand/);
  expect(attachments).toStrictEqual(originalAttachments);
  await expect(handleManageWorkspaceDraft({ action: 'create', data: fields }, empty)).rejects.toThrow(/concrete operand/);
  expect(attachments).toStrictEqual(originalAttachments);
  expect(provider.sendEmail).toHaveBeenCalledTimes(1);
  expect(provider.manageDraft).toHaveBeenCalledTimes(3);
});

it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor', 'alias'])('handles central %s retarget before sending Gmail attachments', async kind => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-gmail-retarget-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const dir of [workspace, approved, outsideDir]) fs.mkdirSync(dir);
  const canonical = path.join(approved, 'source.txt');
  const outside = path.join(outsideDir, 'source.txt');
  const bytes = Buffer.from('Acme approved attachment');
  const outsideBytes = Buffer.from('Acme outside attachment');
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  const attachment: OutgoingGmailAttachment = { id: '', name: '', mimeType: '', size: 0, path: alias, content: '' };
  const fields = { to: ['recipient@example.com'], subject: 'Acme subject', body: 'Acme body', attachments: [attachment] };
  const location = ['attachments', 0, 'path'];
  const context = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
  } } });
  await handleSendWorkspaceEmail(fields, context);
  expect(provider.sendEmail.mock.calls[0]?.[0].attachments?.[0].content).toBe(bytes.toString('base64'));
  const outsideContext = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
  } } });
  await handleSendWorkspaceEmail({ ...fields, attachments: [{ ...attachment, path: outside }] }, outsideContext);
  expect(provider.sendEmail.mock.calls[1]?.[0].attachments?.[0].content).toBe(outsideBytes.toString('base64'));
  vi.clearAllMocks();
  if (kind === 'ancestor') {
    fs.renameSync(approved, path.join(base, 'approved-backup'));
    fs.symlinkSync(outsideDir, approved);
  } else if (kind === 'alias') {
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
  } else {
    fs.unlinkSync(canonical);
    fs.symlinkSync(outside, canonical);
  }
  let result: Awaited<ReturnType<typeof handleSendWorkspaceEmail>> | undefined;
  let error: unknown;
  try { result = await handleSendWorkspaceEmail(fields, context); } catch (caught) { error = caught; }
  if (kind === 'alias') {
    expect(error).toBeUndefined();
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    expect(provider.sendEmail.mock.calls[0]?.[0].attachments?.[0].content).toBe(bytes.toString('base64'));
  } else {
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(result).toBeUndefined();
    expect.soft(provider.sendEmail).not.toHaveBeenCalled();
    expect.soft(provider.manageDraft).not.toHaveBeenCalled();
    expect.soft(JSON.stringify(provider.sendEmail.mock.calls)).not.toContain(outsideBytes.toString('base64'));
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(outside);
  }
});
