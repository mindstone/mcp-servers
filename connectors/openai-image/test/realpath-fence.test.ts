import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const cleanupTargets: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  cleanupTargets.push(dir);
  return dir;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

describe('realpath workspace fence', () => {
  it('accepts workspace-relative and absolute paths inside workspace', async () => {
    const workspace = await makeTempDir('openai-image-workspace-');
    const imagesDir = path.join(workspace, 'images');
    await fs.mkdir(imagesDir, { recursive: true });
    const imagePath = path.join(imagesDir, 'inside.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });

    const relativeResult = await connector.resolveWorkspaceScopedImagePath(
      path.join('images', 'inside.png'),
      'Reference image',
    );
    const absoluteResult = await connector.resolveWorkspaceScopedImagePath(
      imagePath,
      'Reference image',
    );

    expect('errorText' in relativeResult).toBe(false);
    expect('errorText' in absoluteResult).toBe(false);
  });

  it('rejects absolute paths outside workspace with a fence violation', async () => {
    const workspace = await makeTempDir('openai-image-workspace-');
    const outsideDir = await makeTempDir('openai-image-outside-');
    const outsideFile = path.join(outsideDir, 'outside.png');
    await fs.writeFile(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      outsideFile,
      'Reference image',
    );

    expect('errorText' in result).toBe(true);
    if ('errorText' in result) {
      expect(result.errorText).toContain('outside your workspace');
    }
  });

  it('rejects symlink escapes that resolve outside workspace', async () => {
    const workspace = await makeTempDir('openai-image-workspace-');
    const outsideDir = await makeTempDir('openai-image-outside-');
    const outsideFile = path.join(outsideDir, 'outside.png');
    await fs.writeFile(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const linksDir = path.join(workspace, 'links');
    await fs.mkdir(linksDir, { recursive: true });
    const symlinkPath = path.join(linksDir, 'escape.png');
    await fs.symlink(outsideFile, symlinkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      symlinkPath,
      'Reference image',
    );

    expect('errorText' in result).toBe(true);
    if ('errorText' in result) {
      expect(result.errorText).toContain('outside your workspace');
    }
  });

  it('returns ENOENT-shaped error for missing files', async () => {
    const workspace = await makeTempDir('openai-image-workspace-');
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });

    const result = await connector.resolveWorkspaceScopedImagePath(
      'missing.png',
      'Reference image',
    );

    expect('errorText' in result).toBe(true);
    if ('errorText' in result) {
      expect(result.errorText.toLowerCase()).toContain('not found');
      expect(result.errorText).toContain('missing.png');
    }
  });
});
