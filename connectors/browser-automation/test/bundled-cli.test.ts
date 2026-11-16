import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { execAgentBrowser } from '../src/browser-client.js';

it('runs the real bundled binary, whatever is on PATH', async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'browser-automation-path-'));
  try {
    vi.stubEnv('PATH', emptyPath);
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'false');

    const { stdout } = await execAgentBrowser(['--version']);

    expect(stdout).toContain('agent-browser 0.33.2');
  } finally {
    vi.unstubAllEnvs();
    rmdirSync(emptyPath);
  }
});

it("ignores a project config in the host's working directory and keeps the user's own", async () => {
  // The CLI warns about a config file it cannot parse, even for --version, so
  // an unparseable file shows whether it was read without starting a browser.
  const root = mkdtempSync(join(tmpdir(), 'browser-automation-config-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const explicit = join(root, 'explicit-config.json');
  mkdirSync(project);
  mkdirSync(join(home, '.agent-browser'), { recursive: true });
  writeFileSync(join(project, 'agent-browser.json'), '{ not json');
  writeFileSync(join(home, '.agent-browser', 'config.json'), '{ not json');
  writeFileSync(explicit, '{ not json');
  const hostCwd = process.cwd();
  try {
    process.chdir(project);
    vi.stubEnv('AGENT_BROWSER_CONFIG', undefined);
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'false');
    vi.stubEnv('HOME', home);

    const { stderr } = await execAgentBrowser(['--version']);

    expect(stderr).not.toContain('agent-browser.json');
    // On Windows the CLI finds the home folder from the system, not from HOME
    // or USERPROFILE, so this test cannot point it at a fake home there.
    if (process.platform !== 'win32') {
      expect(stderr).toContain(join(home, '.agent-browser', 'config.json'));
    }

    // A config file the user names is still read, on every platform (the CLI
    // refuses to start when that file is unparseable); this also shows the
    // CLI names the config files it reads, so the check above can fail.
    vi.stubEnv('AGENT_BROWSER_CONFIG', explicit);
    await expect(execAgentBrowser(['--version'])).rejects.toThrow('explicit-config.json');
  } finally {
    process.chdir(hostCwd);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
