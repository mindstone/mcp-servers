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
// chmod-based refusal assertions cannot fail-closed when running as uid 0 —
// root bypasses file mode bits, so these tests only mean anything non-root.
const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;

// A value that only exists in the file under test, so finding it in an error
// or log proves the parser echoed the file's contents. Plain hex, like a
// client secret: nothing a token-pattern scrubber would recognise.
function secretMarker(): string {
  return `q${Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('')}`;
}

// The parser quotes only the first few characters of the input, so look for those.
function markerHead(marker: string): string {
  return marker.slice(0, 8);
}

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

  it('a corrupt token file error never repeats the file contents', async () => {
    const marker = secretMarker();
    fs.writeFileSync(
      path.join(tmpDir, 'workspaces', 'T0123ABCD.json'),
      `${marker} {"botToken": "x"}`,
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    const err = await tp.loadTokens().then(
      () => { throw new Error('expected loadTokens to reject'); },
      (e: unknown) => e as { code?: string; message: string; resolution?: string },
    );
    expect(err.code).toBe('TOKEN_FILE_CORRUPT');
    expect(err.message).toBe('Slack token file is not valid JSON.');
    expect(err.resolution).toMatch(/Re-authenticate/);
    expect(JSON.stringify(err)).not.toContain(markerHead(marker));
  });

  it.skipIf(isWindows || isRoot)(
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

  it('a corrupt workspace token file is logged without its contents', async () => {
    const marker = secretMarker();
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
    fs.writeFileSync(path.join(wsDir, 'T111AAA.json'), JSON.stringify({ botToken: 'xoxb-ok', botUserId: 'U1' }));
    fs.writeFileSync(path.join(wsDir, 'T222BBB.json'), `${marker} {"botToken": "x"}`);
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getWorkspaces } = await import('../src/client.js');
    expect(getWorkspaces().map((w) => w.teamId)).toEqual(['T111AAA']);
    const logs = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('T222BBB');
    expect(logs).toContain('not valid JSON');
    expect(logs).not.toContain(markerHead(marker));
  });

  it('a corrupt config.json error never repeats the file contents', async () => {
    const marker = secretMarker();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), `${marker} {"workspaces": []}`);
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    const { getWorkspaces } = await import('../src/client.js');
    let caught: { code?: string; message: string } | undefined;
    try {
      getWorkspaces();
    } catch (e) {
      caught = e as { code?: string; message: string };
    }
    expect(caught?.code).toBe('WORKSPACE_DIR_ALL_CORRUPT');
    expect(caught?.message).toBe('Slack workspace config is not valid JSON.');
    expect(JSON.stringify(caught)).not.toContain(markerHead(marker));
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

  it.skipIf(isWindows || isRoot)(
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
