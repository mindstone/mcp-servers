import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  HubSpotConfigDirInvalidError,
  validateConfigDir,
} from '../src/modules/accounts/manager.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
  tempRoots.push(root);
  return root;
}

function expectConfigDirRejected(dir: string): void {
  expect(() => validateConfigDir(dir)).toThrow(HubSpotConfigDirInvalidError);
}

afterEach(() => {
  vi.unstubAllEnvs();
  __resetAccountManagerForTests();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('HUBSPOT_CONFIG_DIR validation', () => {
  it('rejects path traversal that resolves to the filesystem root', () => {
    const root = path.parse(process.cwd()).root;
    expectConfigDirRejected(path.join(root, '..', '..'));
  });

  it('rejects HUBSPOT_CONFIG_DIR equal to the user home directory', () => {
    expectConfigDirRejected(os.homedir());
  });

  it('rejects HUBSPOT_CONFIG_DIR equal to the system temp directory', () => {
    expectConfigDirRejected(os.tmpdir());
  });

  it('rejects HUBSPOT_CONFIG_DIR equal to MCP_WORKSPACE_PATH', () => {
    const workspaceRoot = createTempRoot('hubspot-m2-workspace-');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceRoot);

    expectConfigDirRejected(workspaceRoot);
  });

  it('rejects a symlinked path component', () => {
    const root = createTempRoot('hubspot-m2-symlink-');
    const target = path.join(root, 'target');
    const symlink = path.join(root, 'link');
    validateConfigDir(target);
    symlinkSync(target, symlink, 'dir');

    expectConfigDirRejected(path.join(symlink, 'config'));
  });

  it('accepts the normal home-directory subpath', () => {
    expect(validateConfigDir(path.join(os.homedir(), '.hubspot-mcp'))).toBe(
      realpathSync.native(path.join(os.homedir(), '.hubspot-mcp')),
    );
  });

  it('auto-creates a missing config directory with mode 0700', () => {
    const root = createTempRoot('hubspot-m2-create-');
    const configDir = path.join(root, 'nested', 'config');

    const accepted = validateConfigDir(configDir);

    expect(accepted).toBe(realpathSync.native(configDir));
    expect(lstatSync(accepted).isDirectory()).toBe(true);
    expect(statSync(accepted).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlink chain that realpath-resolves to the filesystem root', () => {
    const root = createTempRoot('hubspot-m2-root-link-');
    const rootLink = path.join(root, 'root-link');
    symlinkSync(path.parse(process.cwd()).root, rootLink, 'dir');

    expectConfigDirRejected(rootLink);
  });

  it('validates at AccountManager construction time', () => {
    vi.stubEnv('HUBSPOT_CONFIG_DIR', os.homedir());
    __resetAccountManagerForTests();

    expect(() => getAccountManager()).toThrow(HubSpotConfigDirInvalidError);
  });
});
