import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const cleanupTargets: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${prefix}`));
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

  it('allows a declared root only through an in-workspace symlink route', async () => {
    const fixtureRoot = await makeTempDir('root-route-');
    const workspace = path.join(fixtureRoot, 'workspace');
    const declaredRoot = path.join(fixtureRoot, 'declared');
    await fs.mkdir(workspace);
    await fs.mkdir(declaredRoot);
    const declaredFile = path.join(declaredRoot, 'inside.png');
    await fs.writeFile(declaredFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const linkedFile = path.join(workspace, 'linked.png');
    await fs.symlink(declaredFile, linkedFile);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([declaredRoot]),
    });

    const directResult = await connector.resolveWorkspaceScopedImagePath(
      declaredFile,
      'Reference image',
    );
    const traversalResult = await connector.resolveWorkspaceScopedImagePath(
      path.join('..', 'declared', 'inside.png'),
      'Reference image',
    );
    const mixedSeparatorTraversal =
      path.sep === '/'
        ? '..\\declared/inside.png'
        : '../declared\\inside.png';
    const mixedResult = await connector.resolveWorkspaceScopedImagePath(
      mixedSeparatorTraversal,
      'Reference image',
    );
    const linkedResult = await connector.resolveWorkspaceScopedImagePath(
      linkedFile,
      'Reference image',
    );

    expect(directResult).toHaveProperty('errorText');
    expect(traversalResult).toHaveProperty('errorText');
    expect(mixedResult).toHaveProperty('errorText');
    expect(linkedResult).not.toHaveProperty('errorText');
  });

  it('rejects a workspace-prefix collision', async () => {
    const workspace = await makeTempDir('workspace-prefix-');
    const collisionRoot = `${workspace}-evil`;
    cleanupTargets.push(collisionRoot);
    await fs.mkdir(collisionRoot);
    const collisionFile = path.join(collisionRoot, 'outside.png');
    await fs.writeFile(collisionFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      collisionFile,
      'Reference image',
    );

    expect(result).toHaveProperty('errorText');
  });

  it('re-canonicalises a symlinked workspace on every call', async () => {
    const fixtureRoot = await makeTempDir('workspace-retarget-');
    const oldWorkspace = path.join(fixtureRoot, 'old');
    const newWorkspace = path.join(fixtureRoot, 'new');
    const workspaceLink = path.join(fixtureRoot, 'workspace');
    await fs.mkdir(oldWorkspace);
    await fs.mkdir(newWorkspace);
    const oldFile = path.join(oldWorkspace, 'old.png');
    await fs.writeFile(oldFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.symlink(oldWorkspace, workspaceLink);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspaceLink,
    });
    const firstResult = await connector.resolveWorkspaceScopedImagePath(
      path.join(workspaceLink, 'old.png'),
      'Reference image',
    );
    expect(firstResult).not.toHaveProperty('errorText');

    await fs.unlink(workspaceLink);
    await fs.symlink(oldFile, path.join(newWorkspace, 'stale.png'));
    await fs.symlink(newWorkspace, workspaceLink);

    const secondResult = await connector.resolveWorkspaceScopedImagePath(
      path.join(workspaceLink, 'stale.png'),
      'Reference image',
    );
    expect(secondResult).toHaveProperty('errorText');
  });

  it('skips an uncanonicalisable declared root and checks the remaining roots', async () => {
    const workspace = await makeTempDir('workspace-roots-');
    const validRoot = await makeTempDir('valid-root-');
    const validFile = path.join(validRoot, 'inside.png');
    await fs.writeFile(validFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const linkedFile = path.join(workspace, 'inside.png');
    await fs.symlink(validFile, linkedFile);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([
        path.join('/tmp', 'Acme-missing-root'),
        validRoot,
      ]),
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      linkedFile,
      'Reference image',
    );

    expect(result).not.toHaveProperty('errorText');
  });

  it('returns controlled errors for broken links and symlink loops', async () => {
    const workspace = await makeTempDir('workspace-links-');
    const brokenLink = path.join(workspace, 'broken.png');
    const loopLink = path.join(workspace, 'loop.png');
    await fs.symlink(path.join('/tmp', 'Acme-missing-image.png'), brokenLink);
    await fs.symlink(loopLink, loopLink);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });
    const brokenResult = await connector.resolveWorkspaceScopedImagePath(
      brokenLink,
      'Reference image',
    );
    const loopResult = await connector.resolveWorkspaceScopedImagePath(
      loopLink,
      'Reference image',
    );

    expect(brokenResult).toHaveProperty('errorText');
    expect(loopResult).toHaveProperty('errorText');
    if ('errorText' in brokenResult) {
      expect(brokenResult.errorText.toLowerCase()).toContain('not found');
      expect(brokenResult.errorText).not.toContain('Acme-missing-image.png');
    }
    if ('errorText' in loopResult) {
      expect(loopResult.errorText.toLowerCase()).toContain('symbolic link loop');
      expect(loopResult.errorText).not.toContain('ELOOP');
    }
  });

  it('does not fall back to a temporary directory without a workspace', async () => {
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: '',
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      path.join(tmpdir(), 'Acme-image.png'),
      'Reference image',
    );

    expect(result).toEqual({
      errorText:
        'Image path handling requires a workspace. Open or create a workspace first.',
    });
  });
});
