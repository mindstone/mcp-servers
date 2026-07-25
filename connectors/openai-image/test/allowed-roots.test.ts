import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const cleanupTargets: string[] = [];

const makeTempDir = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join('/tmp', `Acme-${label}-`));
  cleanupTargets.push(dir);
  return dir;
};

const writeImageFixture = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

describe('declared symlink roots', () => {
  it('accepts real files inside the workspace without a declared root', async () => {
    const workspace = await makeTempDir('workspace');
    const imagePath = path.join(workspace, 'images', 'inside.png');
    await writeImageFixture(imagePath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });

    await expect(
      connector.resolveWorkspaceScopedImagePath(imagePath, 'Reference image'),
    ).resolves.not.toHaveProperty('errorText');
  });

  it('accepts direct and nested symlink routes into a declared root', async () => {
    const workspace = await makeTempDir('workspace');
    const declaredRoot = await makeTempDir('declared-root');
    const directTarget = path.join(declaredRoot, 'direct.png');
    const nestedTarget = path.join(declaredRoot, 'nested', 'nested.png');
    await writeImageFixture(directTarget);
    await writeImageFixture(nestedTarget);

    const linksDir = path.join(workspace, 'links');
    await fs.mkdir(linksDir, { recursive: true });
    const directLink = path.join(linksDir, 'direct.png');
    const nestedLink = path.join(linksDir, 'nested');
    await fs.symlink(directTarget, directLink);
    await fs.symlink(path.dirname(nestedTarget), nestedLink);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([declaredRoot]),
    });

    await expect(
      connector.resolveWorkspaceScopedImagePath(directLink, 'Reference image'),
    ).resolves.not.toHaveProperty('errorText');
    await expect(
      connector.resolveWorkspaceScopedImagePath(
        path.join(nestedLink, path.basename(nestedTarget)),
        'Reference image',
      ),
    ).resolves.not.toHaveProperty('errorText');
  });

  it('rejects a symlink target outside the workspace and declared roots', async () => {
    const workspace = await makeTempDir('workspace');
    const declaredRoot = await makeTempDir('declared-root');
    const undeclaredRoot = await makeTempDir('undeclared-root');
    const outsideFile = path.join(undeclaredRoot, 'outside.png');
    await writeImageFixture(outsideFile);
    const linkPath = path.join(workspace, 'outside.png');
    await fs.symlink(outsideFile, linkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
      MCP_ALLOWED_SYMLINK_ROOTS: JSON.stringify([declaredRoot]),
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      linkPath,
      'Reference image',
    );

    expect(result).toHaveProperty('errorText');
  });

  it('stays workspace-only when the roots env is unset', async () => {
    const workspace = await makeTempDir('workspace');
    const outsideRoot = await makeTempDir('outside-root');
    const outsideFile = path.join(outsideRoot, 'outside.png');
    await writeImageFixture(outsideFile);
    const linkPath = path.join(workspace, 'outside.png');
    await fs.symlink(outsideFile, linkPath);

    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: workspace,
    });
    const result = await connector.resolveWorkspaceScopedImagePath(
      linkPath,
      'Reference image',
    );

    expect(result).toHaveProperty('errorText');
  });

  const malformedCases: Array<{
    name: string;
    value: (validRoot: string) => string;
  }> = [
    { name: 'bad JSON', value: () => '{Acme' },
    { name: 'a non-array value', value: () => '{"Acme":true}' },
    {
      name: 'a mixed array with a non-string entry',
      value: (validRoot) => JSON.stringify([validRoot, 42]),
    },
    {
      name: 'a mixed array with an empty entry',
      value: (validRoot) => JSON.stringify([validRoot, '']),
    },
    {
      name: 'a mixed array with a relative entry',
      value: (validRoot) => JSON.stringify([validRoot, 'Acme/relative']),
    },
  ];

  for (const malformedCase of malformedCases) {
    it(`rejects the whole roots array and warns once for ${malformedCase.name}`, async () => {
      const workspace = await makeTempDir('workspace');
      const validRoot = await makeTempDir('declared-root');
      const outsideFile = path.join(validRoot, 'outside.png');
      await writeImageFixture(outsideFile);
      const linkPath = path.join(workspace, 'outside.png');
      await fs.symlink(outsideFile, linkPath);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const connector = await importConnectorModule({
        MCP_WORKSPACE_PATH: workspace,
        MCP_ALLOWED_SYMLINK_ROOTS: malformedCase.value(validRoot),
      });
      const result = await connector.resolveWorkspaceScopedImagePath(
        linkPath,
        'Reference image',
      );

      expect(connector.configuredAllowedSymlinkRoots()).toEqual([]);
      expect(result).toHaveProperty('errorText');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  }
});
