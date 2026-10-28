import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { execAgentBrowser } from '../src/browser-client.js';

it('runs the bundled CLI when PATH has no agent-browser executable', async () => {
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
