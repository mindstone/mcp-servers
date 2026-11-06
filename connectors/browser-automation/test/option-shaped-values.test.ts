import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock('node:util', () => ({
  promisify: () => async (...args: unknown[]) => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    return new Promise((resolve, reject) => {
      mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  },
}));

describe('values shaped like command-line options', () => {
  let execFile: ReturnType<typeof vi.fn>;
  let execAgentBrowser: typeof import('../src/browser-client.js')['execAgentBrowser'];

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'false');
    const childProcess = await import('node:child_process');
    execFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    execFile.mockReset();
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: Function) => done(null, '', ''));
    ({ execAgentBrowser } = await import('../src/browser-client.js'));
  });

  it.each([
    [['upload', '--config', '/tmp/a', '/tmp/b']],
    [['fill', '--executable-path', '/tmp/a']],
    [['fill', '@e1', '--allow-file-access']],
    [['type', '@e1', '--auto-connect']],
    [['select', '-p', 'value']],
    [['wait', '--proxy']],
    [['press', '--cdp']],
    [['get', 'text', '--args']],
    [['eval', '--init-script']],
    [['open', '--state']],
    [['click', '--restore=/tmp/a']],
    [['fill', '@e1', '--config=/tmp/a b']],
    [['snapshot', '--full']],
    [['screenshot', '-i']],
  ])('refuses %j before anything runs', async (args) => {
    await expect(execAgentBrowser(args)).rejects.toMatchObject({ code: 'OPTION_SHAPED_VALUE' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not echo the value', async () => {
    const error = await execAgentBrowser(['fill', '@e1', '--secret-looking-value']).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('secret-looking-value');
  });

  it.each([
    [['fill', '@e1', '-5']],
    [['fill', '@e1', '-']],
    [['fill', '@e1', '--']],
    [['fill', '@e1', '--foo bar']],
    [['fill', '@e1', 'plain text --config']],
    [['fill', '@e1', '-1.5']],
    [['wait', '#main-content']],
    [['open', 'https://example.com/?q=--config']],
    [['press', '-']],
    [['snapshot', '-i']],
    [['screenshot', '--full', '--annotate', '-']],
  ])('runs %j', async (args) => {
    await execAgentBrowser(args);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
