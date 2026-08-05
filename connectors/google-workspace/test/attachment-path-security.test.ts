import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { AttachmentService } from '../src/modules/attachments/service.js';
import { ATTACHMENT_FOLDERS } from '../src/modules/attachments/types.js';
import { resolveAttachmentFromPath } from '../src/tools/gmail-handlers.js';

// Redirect hook for simulating a swap race: when `target` is set, the fs.openSync
// that gmail-handlers calls after path validation opens this path instead —
// the stand-in for an intermediate directory (or final component) having been
// swapped for an out-of-workspace symlink between validation and open.
const fsOpenRedirect = vi.hoisted(() => ({ target: undefined as string | undefined }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mockedOpenSync = (target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) =>
    actual.openSync(fsOpenRedirect.target ?? target, flags, mode);
  const actualDefault = (actual as unknown as { default?: typeof actual }).default ?? actual;
  return {
    ...actual,
    default: { ...actualDefault, openSync: mockedOpenSync },
    openSync: mockedOpenSync,
  };
});

const TEST_EMAIL = 'user@example.com';
const GOOGLE_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

describe('Gmail attachment path containment', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    fsOpenRedirect.target = undefined;
    (AttachmentService as unknown as { instance?: AttachmentService }).instance = undefined;
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  function makeWorkspace() {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-attachments-'));
    const workspace = path.join(cleanupDir, 'workspace');
    fs.mkdirSync(workspace);
    return workspace;
  }

  it('rejects path-based attachments when no workspace root is configured', () => {
    const workspace = makeWorkspace();
    const filePath = path.join(workspace, 'note.txt');
    fs.writeFileSync(filePath, 'hello');

    expect(() => resolveAttachmentFromPath(filePath)).toThrow(/MCP_WORKSPACE_PATH/);
  });

  it('rejects symlink attachments', () => {
    const workspace = makeWorkspace();
    const realFile = path.join(workspace, 'real.txt');
    const symlink = path.join(workspace, 'link.txt');
    fs.writeFileSync(realFile, 'hello');
    fs.symlinkSync(realFile, symlink);
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

    expect(() => resolveAttachmentFromPath(symlink)).toThrow(/symbolic link/);
  });

  it('rejects path escape attempts outside the workspace root', () => {
    const workspace = makeWorkspace();
    const outsideFile = path.join(cleanupDir!, 'outside.txt');
    fs.writeFileSync(outsideFile, 'secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

    expect(() => resolveAttachmentFromPath(path.join(workspace, '..', 'outside.txt'))).toThrow(/within the workspace/);
  });

  it('reads a genuine in-workspace attachment', () => {
    const workspace = makeWorkspace();
    const filePath = path.join(workspace, 'note.txt');
    fs.writeFileSync(filePath, 'hello workspace');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

    const resolved = resolveAttachmentFromPath(filePath);

    expect(resolved.name).toBe('note.txt');
    expect(Buffer.from(resolved.content, 'base64').toString()).toBe('hello workspace');
  });

  it('fails closed when an intermediate directory is swapped before the open', () => {
    const workspace = makeWorkspace();
    const dir = path.join(workspace, 'dir');
    fs.mkdirSync(dir);
    const sourcePath = path.join(dir, 'file.txt');
    fs.writeFileSync(sourcePath, 'Legitimate attachment content.');
    const impostorPath = path.join(cleanupDir!, 'impostor.txt');
    fs.writeFileSync(impostorPath, 'Out-of-workspace content the fence never validated.');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

    // Simulate the swap: containment and the pre-open stat validated the
    // in-workspace file, but the path opened for the read resolves through a
    // swapped ancestor to a different (out-of-workspace) inode.
    fsOpenRedirect.target = impostorPath;
    expect(() => resolveAttachmentFromPath(sourcePath)).toThrow(/changed while it was being verified/);
  });

  it('makes no Gmail API request when the attachment is swapped mid-verification', async () => {
    const workspace = makeWorkspace();
    const dir = path.join(workspace, 'dir');
    fs.mkdirSync(dir);
    const sourcePath = path.join(dir, 'file.txt');
    fs.writeFileSync(sourcePath, 'Legitimate attachment content.');
    const impostorPath = path.join(cleanupDir!, 'impostor.txt');
    fs.writeFileSync(impostorPath, 'Out-of-workspace content the fence never validated.');

    const credentialsPath = path.join(cleanupDir!, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cleanupDir!, 'accounts.json'),
      JSON.stringify({
        accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Attachment race test user' }],
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
    vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir!, 'accounts.json'));
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

    let sendRequests = 0;
    mswServer.use(
      http.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', () => {
        sendRequests += 1;
        return HttpResponse.json({ id: 'must-never-be-sent' });
      }),
    );

    vi.resetModules();
    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await initializeAllServices();
    const gmail = await import('../src/tools/gmail-handlers.js');

    fsOpenRedirect.target = impostorPath;
    await expect(gmail.handleSendWorkspaceEmail({
      to: ['recipient@example.com'],
      subject: 'Race test',
      body: 'Hello',
      attachments: [{ path: sourcePath }],
    })).rejects.toThrow(/changed while it was being verified/);

    expect(sendRequests).toBe(0);
  });

  async function processNamedAttachment(name: string) {
    const workspace = makeWorkspace();
    const service = AttachmentService.getInstance({ basePath: path.join(workspace, 'attachments') });
    return await service.processAttachment('user@example.com', {
      content: Buffer.from('hello').toString('base64'),
      metadata: {
        name,
        mimeType: 'application/pdf',
        size: 5,
      },
    }, ATTACHMENT_FOLDERS.EMAIL);
  }

  it('rejects traversal attachment filenames', async () => {
    const result = await processNamedAttachment('../../etc/passwd.txt');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid attachment filename/);
  });

  it('accepts harmless attachment filenames', async () => {
    const result = await processNamedAttachment('harmless.pdf');

    expect(result.success).toBe(true);
    expect(result.attachment?.name).toBe('harmless.pdf');
    expect(result.attachment?.path).toContain(`${path.sep}email${path.sep}`);
    expect(fs.existsSync(result.attachment!.path)).toBe(true);
  });

  it.each(['with/slash.pdf', '', '.', 'with\0null.txt'])(
    'rejects invalid attachment filename %j',
    async (filename) => {
      const result = await processNamedAttachment(filename);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid attachment filename/);
    }
  );
});
