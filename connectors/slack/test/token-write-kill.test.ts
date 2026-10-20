/**
 * §13.3 "kill mid-write" evidence for saveTokens: if the process dies while
 * rewriting the token file, the file at the final path is still a complete
 * token file (the previous one, or a whole new one), never a partial write.
 *
 * A child process runs the real saveTokens in a loop with large payloads and
 * is SIGKILLed while it is writing. saveTokens writes to a temp file and
 * renames it into place, so a kill can leave a `<team>.json.tmp.<pid>.<ms>`
 * file behind (its catch-block cleanup never runs on SIGKILL); that is
 * expected and does not affect the token file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SlackTokenProvider } from '../src/tokenProvider.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(PKG_ROOT, 'test', 'fixtures', 'token-write-loop.ts');
const TEAM_ID = 'T0123ABCD';
const PAD_BYTES = 4_000_000;
const KILL_AFTER_SAVES = 3;

describe('saveTokens — killed mid-write', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-kill-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves a complete token file at the final path after SIGKILL', async () => {
    const tokenPath = path.join(tmpDir, 'workspaces', `${TEAM_ID}.json`);
    const initial = {
      botToken: 'xoxb-initial',
      botUserId: 'U999',
      botRefreshToken: 'xoxe-1-initial',
      botExpiresAt: Date.now() + 60_000,
    };
    const writer = new SlackTokenProvider(tmpDir, TEAM_ID, 'cid', 'csec');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (writer as any).saveTokens(initial);

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD, tmpDir, TEAM_ID, String(PAD_BYTES)],
      { cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let saves = 0;
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        let stdout = '';
        const guard = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          saves = (stdout.match(/^saved \d+$/gm) ?? []).length;
          // Kill while the next save is in flight, after a few have completed.
          if (saves >= KILL_AFTER_SAVES) child.kill('SIGKILL');
        });
        child.on('exit', (code, signal) => {
          clearTimeout(guard);
          resolve({ code, signal });
        });
      },
    );

    expect(exit.signal, `child exited without being killed: ${stderr}`).toBe('SIGKILL');
    // Positive control: the child really was rewriting the file when killed.
    expect(saves, stderr).toBeGreaterThanOrEqual(KILL_AFTER_SAVES);

    // After at least one completed loop save, the previous file is itself a
    // loop write, so "old or new" both mean one complete loop payload.
    const onDisk = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as typeof initial;
    const pad = 'x'.repeat(PAD_BYTES);
    expect(onDisk.botToken).toMatch(/^xoxb-\d-/);
    expect(onDisk.botToken.length).toBe(7 + PAD_BYTES);
    expect(onDisk.botToken.slice(7) === pad).toBe(true);
    expect(onDisk.botRefreshToken).toBe(`xoxe-1-loop-${onDisk.botToken[5]}`);

    // The provider's own loader accepts the file (no TOKEN_FILE_CORRUPT).
    const reader = new SlackTokenProvider(tmpDir, TEAM_ID, 'cid', 'csec');
    const loaded = await reader.loadTokens();
    expect(loaded?.botToken).toBe(onDisk.botToken);

    // Only the token file and, at most, the killed write's temp file remain.
    const leftovers = fs.readdirSync(path.dirname(tokenPath)).filter((f) => f !== `${TEAM_ID}.json`);
    for (const f of leftovers) {
      expect(f).toMatch(new RegExp(`^${TEAM_ID}\\.json\\.tmp\\.${child.pid}\\.\\d+$`));
    }
    expect(leftovers.length).toBeLessThanOrEqual(1);
  }, 20_000);
});
