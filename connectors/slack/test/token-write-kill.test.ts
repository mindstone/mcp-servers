/**
 * §13.3 "kill mid-write" evidence for saveTokens: a process killed while it is
 * writing the next token file leaves the previous complete token file at the
 * final path, and the provider still loads it.
 *
 * A child process runs the real saveTokens in a loop. Its fixture lets a few
 * saves complete, then stops the next save after it has written half of its
 * temp file and holds it there (see fixtures/token-write-loop.ts). With the
 * child stopped at that point, the test checks that the temp file really holds
 * a partial, unparseable payload, then SIGKILLs the child. It then checks that
 * the final path holds exactly the last completed save, that loadTokens()
 * returns it, and that the killed write's temp file is the only leftover (its
 * catch-block cleanup never runs on SIGKILL). The interruption point is fixed
 * by the fixture, so this does not depend on when the kill lands; it covers a
 * kill during the temp-file write, not every other point in saveTokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SlackTokenProvider } from '../src/tokenProvider.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(PKG_ROOT, 'test', 'fixtures', 'token-write-loop.ts');
const TEAM_ID = 'T0123ABCD';
const PAD_BYTES = 64 * 1024;
const INTERRUPT_AT = 3;

describe('saveTokens — killed mid-write', () => {
  let tmpDir: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-kill-'));
  });

  afterEach(() => {
    // Never leave our own child running if an assertion failed before the kill.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the previous complete token file when killed while writing the next one', async () => {
    const tokenPath = path.join(tmpDir, 'workspaces', `${TEAM_ID}.json`);
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD, tmpDir, TEAM_ID, String(PAD_BYTES), String(INTERRUPT_AT)],
      { cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child = proc;
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (chunk) => (stdout += chunk));
    proc.stderr!.on('data', (chunk) => (stderr += chunk));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      proc.on('exit', (_code, signal) => resolve(signal)),
    );

    // Wait until the child is holding a half-written temp file.
    const tmpPath = await new Promise<string>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error(`no partial write within 15 s\nstdout: ${stdout}\nstderr: ${stderr}`)),
        15_000,
      );
      const onData = (): void => {
        const match = /^partial (.+)\n/m.exec(stdout);
        if (!match) return;
        clearTimeout(guard);
        proc.stdout!.off('data', onData);
        resolve(match[1]);
      };
      proc.stdout!.on('data', onData);
      proc.on('exit', () => {
        clearTimeout(guard);
        reject(new Error(`child exited before a partial write\nstdout: ${stdout}\nstderr: ${stderr}`));
      });
    });

    // The earlier saves completed, and the interrupted write is real and partial.
    expect(stdout.match(/^saved \d+$/gm)).toEqual(
      Array.from({ length: INTERRUPT_AT }, (_, i) => `saved ${i}`),
    );
    expect(path.dirname(tmpPath)).toBe(path.dirname(tokenPath));
    const partial = fs.readFileSync(tmpPath, 'utf-8');
    expect(partial.length).toBeGreaterThan(0);
    expect(() => JSON.parse(partial)).toThrow(SyntaxError);

    expect(proc.kill('SIGKILL')).toBe(true);
    expect(await exited, stderr).toBe('SIGKILL');

    // The final path holds the last completed save, unchanged.
    const previous = INTERRUPT_AT - 1;
    const expectedBotToken = `xoxb-${previous}-${'x'.repeat(PAD_BYTES)}`;
    const onDisk = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.botToken === expectedBotToken).toBe(true);
    expect(onDisk.botRefreshToken).toBe(`xoxe-1-loop-${previous}`);
    expect(onDisk.botUserId).toBe('U999');

    // The provider's own loader accepts the file (no TOKEN_FILE_CORRUPT).
    const loaded = await new SlackTokenProvider(tmpDir, TEAM_ID, 'cid', 'csec').loadTokens();
    expect(loaded?.botToken === expectedBotToken).toBe(true);
    expect(loaded?.botRefreshToken).toBe(`xoxe-1-loop-${previous}`);

    // The killed write's temp file is the only leftover.
    const leftovers = fs.readdirSync(path.dirname(tokenPath)).filter((f) => f !== `${TEAM_ID}.json`);
    expect(leftovers).toEqual([path.basename(tmpPath)]);
  }, 30_000);
});
