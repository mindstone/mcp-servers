/**
 * HIGH-7 / HIGH-8 — distinct error types for missing / corrupt /
 * permission-denied token and workspace-config files.
 *
 * § 5.3 requires "distinguish corruption, missing file, and permission-
 * denied as distinct errors with distinct recovery guidance". Returning
 * `null` (or `[]`) from every read failure silently turns a `chmod 000`
 * file or a partial-write corruption into a "fresh install" UX, which
 * gives the wrong remediation guidance and hides actual data loss.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const isWindows = process.platform === 'win32';

describe('SlackTokenProvider.loadTokens — distinct error types', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-load-tokens-'));
    fs.mkdirSync(path.join(tmpDir, 'workspaces'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    try {
      // Restore mode in case a chmod 000 left dirs un-removable.
      if (fs.existsSync(tmpDir)) {
        for (const f of fs.readdirSync(path.join(tmpDir, 'workspaces'))) {
          try {
            fs.chmodSync(path.join(tmpDir, 'workspaces', f), 0o600);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('missing token file returns null (legitimate fresh-install path)', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    const tokens = await tp.loadTokens();
    expect(tokens).toBeNull();
  });

  it('corrupt JSON throws TOKEN_FILE_CORRUPT distinctly', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workspaces', 'T0123ABCD.json'), '{ this is not valid json');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    await expect(tp.loadTokens()).rejects.toMatchObject({ code: 'TOKEN_FILE_CORRUPT' });
  });

  it.skipIf(isWindows)(
    'chmod 000 token file throws TOKEN_FILE_PERMISSION_DENIED distinctly',
    async () => {
      const file = path.join(tmpDir, 'workspaces', 'T0123ABCD.json');
      fs.writeFileSync(file, JSON.stringify({ botToken: 'x', botUserId: 'U' }));
      fs.chmodSync(file, 0o000);
      const { SlackTokenProvider } = await import('../src/tokenProvider.js');
      const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
      try {
        await expect(tp.loadTokens()).rejects.toMatchObject({
          code: 'TOKEN_FILE_PERMISSION_DENIED',
        });
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  it('TOKEN_FILE_CORRUPT next_step → authenticate_slack_workspace (must reauth)', async () => {
    const { ConnectorError, DEFAULT_NEXT_STEP_BY_CODE } = await import('../src/types.js');
    const err = new ConnectorError('corrupt', 'TOKEN_FILE_CORRUPT', 'reauth', { path: '/x' });
    expect(err.nextStep).toBe(DEFAULT_NEXT_STEP_BY_CODE.TOKEN_FILE_CORRUPT);
    expect(err.nextStep).toBe('authenticate_slack_workspace');
  });

  it('TOKEN_FILE_PERMISSION_DENIED next_step → list_slack_workspaces (operational issue, surface to user)', async () => {
    const { ConnectorError, DEFAULT_NEXT_STEP_BY_CODE } = await import('../src/types.js');
    const err = new ConnectorError('chmod 000', 'TOKEN_FILE_PERMISSION_DENIED', 'check perms');
    expect(err.nextStep).toBe(DEFAULT_NEXT_STEP_BY_CODE.TOKEN_FILE_PERMISSION_DENIED);
    expect(err.nextStep).toBe('list_slack_workspaces');
  });
});

describe('getWorkspaces — distinct error types', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-getws-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    try {
      const cfg = path.join(tmpDir, 'config.json');
      if (fs.existsSync(cfg)) {
        try {
          fs.chmodSync(cfg, 0o600);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SLACK_CONFIG_PATH unset → empty array (no envs wired yet)', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', '');
    const { getWorkspaces } = await import('../src/client.js');
    expect(getWorkspaces()).toEqual([]);
  });

  it('config dir missing config.json (ENOENT) → empty array (legitimate)', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    const { getWorkspaces } = await import('../src/client.js');
    expect(getWorkspaces()).toEqual([]);
  });

  it('one of two workspaces has corrupt token file → returns the readable one, logs the corrupt one', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        workspaces: [
          { teamId: 'T111AAA', teamName: 'WS One', authedAt: new Date().toISOString() },
          { teamId: 'T222BBB', teamName: 'WS Two', authedAt: new Date().toISOString() },
        ],
      }),
    );
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(wsDir, 'T111AAA.json'),
      JSON.stringify({ botToken: 'xoxb-ok', botUserId: 'U1' }),
    );
    fs.writeFileSync(path.join(wsDir, 'T222BBB.json'), '{not valid json');
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getWorkspaces } = await import('../src/client.js');
    const out = getWorkspaces();
    expect(out.map((w) => w.teamId)).toEqual(['T111AAA']);
    const logs = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('Skipping unreadable workspace token file');
    expect(logs).toContain('T222BBB');
    errSpy.mockRestore();
  });

  it('all workspaces corrupt → throws WORKSPACE_DIR_ALL_CORRUPT', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        workspaces: [
          { teamId: 'T111AAA', teamName: 'WS One', authedAt: new Date().toISOString() },
          { teamId: 'T222BBB', teamName: 'WS Two', authedAt: new Date().toISOString() },
        ],
      }),
    );
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(wsDir, 'T111AAA.json'), '{nope');
    fs.writeFileSync(path.join(wsDir, 'T222BBB.json'), 'also bad');
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getWorkspaces } = await import('../src/client.js');
    expect(() => getWorkspaces()).toThrow(/WORKSPACE_DIR_ALL_CORRUPT|All Slack workspace token files/);
  });

  it('corrupt config.json → throws WORKSPACE_DIR_ALL_CORRUPT', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ not valid json');
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    const { getWorkspaces } = await import('../src/client.js');
    expect(() => getWorkspaces()).toThrow(/WORKSPACE_DIR_ALL_CORRUPT|not valid JSON/);
  });

  it.skipIf(isWindows)(
    'chmod 000 config.json → throws WORKSPACE_DIR_PERMISSION_DENIED',
    async () => {
      const cfg = path.join(tmpDir, 'config.json');
      fs.writeFileSync(cfg, JSON.stringify({ workspaces: [] }));
      fs.chmodSync(cfg, 0o000);
      vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
      const { getWorkspaces } = await import('../src/client.js');
      try {
        expect(() => getWorkspaces()).toThrow(
          /WORKSPACE_DIR_PERMISSION_DENIED|not readable/,
        );
      } finally {
        fs.chmodSync(cfg, 0o600);
      }
    },
  );
});
