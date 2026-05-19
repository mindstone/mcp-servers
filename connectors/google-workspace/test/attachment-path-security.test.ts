import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentService } from '../src/modules/attachments/service.js';
import { ATTACHMENT_FOLDERS } from '../src/modules/attachments/types.js';
import { resolveAttachmentFromPath } from '../src/tools/gmail-handlers.js';

describe('Gmail attachment path containment', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
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
