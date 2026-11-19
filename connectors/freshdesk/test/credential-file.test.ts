import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFreshdeskHandlers } from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import fs, {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

/**
 * accounts.json is replaced atomically (temp file + fsync + rename) and must
 * be a regular file: a symlink at that path is refused on read and on write.
 */

const isWindows = process.platform === 'win32';

const TWO_ACCOUNTS = {
  accounts: [
    { domain: 'testacme', apiKey: 'mock-test-key', agentEmail: 'agent@testacme.freshdesk.com' },
    { domain: 'second', apiKey: 'second-key' },
  ],
  defaultAccount: 'testacme',
  defaultAccountKey: 'defaultDomain',
};

describe('Freshdesk accounts.json file handling', () => {
  let testClient: McpTestClient | undefined;
  let cleanupConfig: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (testClient) await testClient.close();
    testClient = undefined;
    if (cleanupConfig) cleanupConfig();
    cleanupConfig = undefined;
    vi.unstubAllEnvs();
  });

  async function setup(options: Parameters<typeof createTempConfig>[0] = TWO_ACCOUNTS) {
    const tc = createTempConfig(options);
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });
    return { ...tc, accountsPath: join(tc.configPath, 'accounts.json') };
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok?: boolean; code?: string; error?: string; [key: string]: unknown }> {
    const result = await testClient!.client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
  }

  /** The same module instance the server under test uses (createTestClient reset the registry). */
  async function authModule() {
    return import('../src/auth.js');
  }

  function replaceWithSymlink(accountsPath: string, targetPath: string): void {
    unlinkSync(accountsPath);
    symlinkSync(targetPath, accountsPath);
  }

  async function expectRefusal(): Promise<void> {
    const listed = await callTool('list_freshdesk_accounts', {});
    expect(listed.accounts).toEqual([]);

    const agents = await callTool('list_freshdesk_agents', {});
    expect(agents.ok).toBe(false);
    expect(agents.error).toBe('No Freshdesk account connected');

    const configured = await callTool('configure_freshdesk', { domain: 'newdomain', api_key: 'new-key' });
    expect(configured.ok).toBe(false);
    expect(configured.code).toBe('ACCOUNTS_UNREADABLE');

    const removed = await callTool('remove_freshdesk_account', { domain: 'testacme' });
    expect(removed.ok).toBe(false);
    expect(removed.code).toBe('ACCOUNTS_UNREADABLE');
  }

  // ─── Reads refuse a symlinked accounts.json ──────────────────────

  it.skipIf(isWindows)('refuses a symlink at accounts.json that points to a valid accounts file', async () => {
    const { configPath, accountsPath } = await setup();
    const targetPath = join(configPath, 'link-target.json');
    writeFileSync(targetPath, readFileSync(accountsPath));
    const targetBefore = readFileSync(targetPath);
    replaceWithSymlink(accountsPath, targetPath);

    await expectRefusal();

    expect(readFileSync(targetPath).equals(targetBefore)).toBe(true);
  });

  it.skipIf(isWindows)('refuses a dangling symlink at accounts.json and creates nothing at its target', async () => {
    const { configPath, accountsPath } = await setup();
    const targetPath = join(configPath, 'missing-target.json');
    replaceWithSymlink(accountsPath, targetPath);

    await expectRefusal();

    expect(existsSync(targetPath)).toBe(false);
  });

  it.skipIf(isWindows)('clears credentials loaded earlier once accounts.json becomes a symlink', async () => {
    const { configPath, accountsPath } = await setup();
    const auth = await authModule();
    expect(auth.getAccount()?.domain).toBe('testacme');

    const targetPath = join(configPath, 'link-target.json');
    writeFileSync(targetPath, readFileSync(accountsPath));
    replaceWithSymlink(accountsPath, targetPath);

    expect(auth.getAccount()).toBeUndefined();
    expect(auth.loadAccounts()).toBe(false);
    expect(auth.getAccountsConfig().accounts).toEqual([]);
  });

  // ─── Missing file stays the healthy "no accounts yet" state ──────

  it('configures the first account when accounts.json is missing', async () => {
    const { accountsPath } = await setup({ empty: true });
    expect(existsSync(accountsPath)).toBe(false);

    const configured = await callTool('configure_freshdesk', { domain: 'testacme', api_key: 'first-key' });
    expect(configured.ok).toBe(true);

    const saved = JSON.parse(readFileSync(accountsPath, 'utf8'));
    expect(saved.accounts.map((a: { domain: string }) => a.domain)).toEqual(['testacme']);
    expect(saved.defaultDomain).toBe('testacme');
  });

  // ─── Atomic replace ──────────────────────────────────────────────

  it('leaves no temp file behind and makes the folder and file owner-only after a save', async () => {
    const { configPath, accountsPath } = await setup();
    // Start permissive, so a save that skips the hardening step fails here.
    if (!isWindows) {
      chmodSync(configPath, 0o755);
      chmodSync(accountsPath, 0o644);
    }

    const configured = await callTool('configure_freshdesk', { domain: 'newdomain', api_key: 'new-key' });
    expect(configured.ok).toBe(true);

    expect(readdirSync(configPath).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
    if (!isWindows) {
      expect(statSync(accountsPath).mode & 0o777).toBe(0o600);
      expect(statSync(configPath).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces the accounts.json inode on save rather than rewriting it in place', async () => {
    const { accountsPath } = await setup();
    const inodeBefore = statSync(accountsPath).ino;

    const configured = await callTool('configure_freshdesk', { domain: 'newdomain', api_key: 'new-key' });
    expect(configured.ok).toBe(true);

    expect(statSync(accountsPath).ino).not.toBe(inodeBefore);
    const saved = JSON.parse(readFileSync(accountsPath, 'utf8'));
    expect(saved.accounts.map((a: { domain: string }) => a.domain)).toEqual([
      'testacme',
      'second',
      'newdomain',
    ]);
  });

  // ─── A failed save changes nothing ───────────────────────────────

  it('keeps the file and the in-memory config unchanged when the save fails before the rename', async () => {
    const { configPath, accountsPath } = await setup();
    const auth = await authModule();
    expect(auth.loadAccounts()).toBe(true);
    const bytesBefore = readFileSync(accountsPath);
    const snapshotBefore = JSON.parse(JSON.stringify(auth.getAccountsConfig()));

    // Fail the step that would put the new file in place. (A read-only
    // directory is no use here: the owner may always chmod it back.)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    });

    const configured = await callTool('configure_freshdesk', { domain: 'newdomain', api_key: 'new-key' });
    expect(configured.ok).toBe(false);
    expect(auth.getAccountsConfig()).toEqual(snapshotBefore);

    const removed = await callTool('remove_freshdesk_account', { domain: 'testacme' });
    expect(removed.ok).toBe(false);
    expect(auth.getAccountsConfig()).toEqual(snapshotBefore);

    expect(renameSpy).toHaveBeenCalledTimes(2);
    renameSpy.mockRestore();

    expect(readFileSync(accountsPath).equals(bytesBefore)).toBe(true);
    const onDisk = JSON.parse(readFileSync(accountsPath, 'utf8'));
    expect(onDisk.defaultDomain).toBe('testacme');
    expect(onDisk.accounts).toHaveLength(2);
    expect(readdirSync(configPath).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });
});
