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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const slackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

describe('token file reads refuse symlinks and non-regular files', () => {
  let tmpDir: string;
  let wsDir: string;
  const validTokens = JSON.stringify({ botToken: 'xoxb-example', botUserId: 'UEXAMPLE' });

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-symlink-'));
    wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(teamIds: string[]): void {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        workspaces: teamIds.map((teamId) => ({ teamId, teamName: teamId, authedAt: new Date().toISOString() })),
      }),
    );
  }

  it('a regular token file still loads', async () => {
    fs.writeFileSync(path.join(wsDir, 'T0123ABCD.json'), validTokens, { mode: 0o600 });
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    expect(await tp.loadTokens()).toMatchObject({ botToken: 'xoxb-example' });
  });

  it.skipIf(isWindows)('a symlinked token file pointing at valid tokens is refused with TOKEN_FILE_UNREADABLE', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, validTokens);
    fs.symlinkSync(elsewhere, path.join(wsDir, 'T0123ABCD.json'));
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    const err = await tp.loadTokens().then(
      () => { throw new Error('expected loadTokens to reject'); },
      (e: unknown) => e as { code?: string; message: string; resolution?: string; nextStep?: string },
    );
    expect(err.code).toBe('TOKEN_FILE_UNREADABLE');
    expect(err.message).toBe('Slack token file is a symbolic link or not a regular file; refusing to read it.');
    expect(err.resolution).toBe(
      'Remove the symbolic link or special file at this path itself (not whatever it points to), then reconnect Slack via your MCP host application to write a fresh token file.',
    );
    expect(err.nextStep).toBe('authenticate_slack_workspace');
    expect(JSON.stringify(err)).not.toContain('xoxb-example');
  });

  it('a directory at the token path is refused with TOKEN_FILE_UNREADABLE', async () => {
    fs.mkdirSync(path.join(wsDir, 'T0123ABCD.json'));
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    await expect(tp.loadTokens()).rejects.toMatchObject({
      code: 'TOKEN_FILE_UNREADABLE',
      message: 'Slack token file is a symbolic link or not a regular file; refusing to read it.',
      nextStep: 'authenticate_slack_workspace',
    });
  });

  // Runs on every platform: the Windows branch is picked by process.platform,
  // and its lstat refusal must happen before any open.
  it('on Windows, a symlink at the token path is refused by lstat before any open', async () => {
    const lstatSync = vi.fn(() => ({ isSymbolicLink: () => true }));
    const openSync = vi.fn(() => { throw new Error('openSync must not be called'); });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, lstatSync, openSync };
    });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const { readRegularFileNoFollow, UnsafeTokenFileError } = await import('../src/safeTokenFileRead.js');
      expect(() => readRegularFileNoFollow(path.join(wsDir, 'T0123ABCD.json'))).toThrow(UnsafeTokenFileError);
      expect(lstatSync).toHaveBeenCalledTimes(1);
      expect(openSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.doUnmock('node:fs');
    }
  });

  // A blocking open of a FIFO with no writer hangs the whole event loop, so an
  // in-process test could never time out. The load runs in a child process the
  // parent kills after a bounded wait; a hang shows up as a failed test.
  it.skipIf(isWindows)('a FIFO at the token path is refused without hanging', () => {
    const fifo = path.join(wsDir, 'T0123ABCD.json');
    execFileSync('mkfifo', [fifo]);
    const providerUrl = pathToFileURL(path.join(slackRoot, 'src', 'tokenProvider.ts')).href;
    const script = [
      `const { SlackTokenProvider } = await import(${JSON.stringify(providerUrl)});`,
      `const tp = new SlackTokenProvider(${JSON.stringify(tmpDir)}, 'T0123ABCD', 'cid', 'csec');`,
      `try { await tp.loadTokens(); console.log('LOADED'); } catch (e) { console.log('CODE=' + e.code); }`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: slackRoot, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    });
    expect(child.error, 'child process hung reading the FIFO and was killed').toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('CODE=TOKEN_FILE_UNREADABLE');
  }, 20_000);

  it.skipIf(isWindows)('getWorkspaces skips a symlinked token file and keeps the readable one', async () => {
    writeConfig(['T111AAA', 'T222BBB']);
    fs.writeFileSync(path.join(wsDir, 'T111AAA.json'), validTokens);
    const elsewhere = path.join(tmpDir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, validTokens);
    fs.symlinkSync(elsewhere, path.join(wsDir, 'T222BBB.json'));
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getWorkspaces } = await import('../src/client.js');
    expect(getWorkspaces().map((w) => w.teamId)).toEqual(['T111AAA']);
    const logs = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('T222BBB');
    expect(logs).toContain('symbolic link or not a regular file');
  });

  it.skipIf(isWindows)('getWorkspaces throws WORKSPACE_DIR_ALL_CORRUPT when the only token file is a symlink', async () => {
    writeConfig(['T111AAA']);
    const elsewhere = path.join(tmpDir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, validTokens);
    fs.symlinkSync(elsewhere, path.join(wsDir, 'T111AAA.json'));
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getWorkspaces } = await import('../src/client.js');
    expect(() => getWorkspaces()).toThrow(expect.objectContaining({ code: 'WORKSPACE_DIR_ALL_CORRUPT' }));
  });

  it('getWorkspaces still lists a workspace whose token file is missing', async () => {
    writeConfig(['T111AAA']);
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    const { getWorkspaces } = await import('../src/client.js');
    expect(getWorkspaces().map((w) => w.teamId)).toEqual(['T111AAA']);
  });
});

describe('saveTokens creates its temp file exclusively', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-save-excl-'));
    fs.mkdirSync(path.join(tmpDir, 'workspaces'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)('a symlink planted at the temp path makes the save fail; its target and the link are untouched', async () => {
    const tokenPath = path.join(tmpDir, 'workspaces', 'T0123ABCD.json');
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const tmpPath = `${tokenPath}.tmp.${process.pid}.${fixedNow}`;
    const victim = path.join(tmpDir, 'victim');
    fs.writeFileSync(victim, 'victim-contents');
    fs.symlinkSync(victim, tmpPath);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tp as any).saveTokens({ botToken: 'xoxb-new', botUserId: 'U1' }),
    ).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });

    expect(fs.readFileSync(victim, 'utf-8')).toBe('victim-contents');
    expect(fs.lstatSync(tmpPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
  });
});
