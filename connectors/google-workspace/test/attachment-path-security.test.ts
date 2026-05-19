import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAttachmentFromPath } from '../src/tools/gmail-handlers.js';

describe('Gmail attachment path containment', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
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
});
