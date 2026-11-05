import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOX = fileURLToPath(new URL('../box/box.py', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'computers-box-'));
const env = { ...process.env, COMPUTER_BOX_ROOT: root };
const b64 = (text: string) => Buffer.from(text).toString('base64');
const box = (...args: string[]) => execFileSync('python3', [BOX, ...args], { env, encoding: 'utf8' });
const wait = (job: string, seconds = 5, offset = 0) => JSON.parse(box('wait', job, String(seconds), String(offset)));
const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
const running = (marker: string) => execFileSync('bash', ['-c', `ps -eo args | grep -c '[${marker[0]}]${marker.slice(1)}' || true`], { encoding: 'utf8' }).trim();

// The runner on the computer: run, wait, output paging and cancel. Locally there is usually no
// cgroup we may create, so this covers the process-group fallback; cgroups are checked live (QA).
describe.skipIf(process.platform === 'win32')('box.py', () => {
  it('runs a command and returns its exit code and output', () => {
    box('run', 'job-0000000001', '60', user, b64(root), b64('echo hello; echo oops >&2; exit 3'));
    // A login shell may print its own lines first, so only the end is the command's.
    const status = wait('job-0000000001');
    expect(status).toMatchObject({ state: 'finished', exit_code: 3, more_output: false });
    expect(Buffer.from(status.output_b64, 'base64').toString().endsWith('hello\noops\n')).toBe(true);
  });

  it('returns long output in pieces from an offset', () => {
    box('run', 'job-0000000002', '60', user, b64(root), b64('head -c 70000 /dev/zero | tr "\\0" a'));
    const first = wait('job-0000000002');
    expect(first.more_output).toBe(true);
    const rest = wait('job-0000000002', 0, first.next_offset);
    expect(rest.more_output).toBe(false);
    expect(rest.next_offset).toBe(first.next_offset + Buffer.from(rest.output_b64, 'base64').length);
    expect(rest.next_offset).toBeGreaterThanOrEqual(70000);
  });

  it('cancel ends the command and its background children', () => {
    box('run', 'job-0000000003', '60', user, b64(root), b64('sleep 4242 & sleep 4243'));
    expect(wait('job-0000000003', 1).state).toBe('running');
    box('cancel', 'job-0000000003');
    expect(wait('job-0000000003', 1)).toMatchObject({ state: 'stopped', stopped_reason: 'cancelled' });
    expect(running('sleep 424')).toBe('0');
  });

  it('ends a command at its timeout', () => {
    box('run', 'job-0000000004', '1', user, b64(root), b64('sleep 30'));
    expect(wait('job-0000000004', 8)).toMatchObject({ state: 'stopped', stopped_reason: 'timeout' });
  });

  it('ends what a finished command left running in the background', () => {
    box('run', 'job-0000000005', '60', user, b64(root), b64('sleep 4252 & echo started'));
    expect(wait('job-0000000005', 5).state).toBe('finished');
    execFileSync('sleep', ['3']);
    expect(running('sleep 4252')).toBe('0');
  });

  it('runs nothing when the folder does not exist', () => {
    box('run', 'job-0000000006', '60', user, b64(join(root, 'missing')), b64('touch ran-anyway'));
    const status = wait('job-0000000006', 5);
    expect(status).toMatchObject({ state: 'finished', exit_code: 2 });
    expect(Buffer.from(status.output_b64, 'base64').toString()).toContain('does not exist on this computer; nothing was run.');
  });

  it('ends every job before a stop', () => {
    box('run', 'job-0000000007', '60', user, b64(root), b64('sleep 4262'));
    box('end-all');
    expect(wait('job-0000000007', 1)).toMatchObject({ state: 'stopped', stopped_reason: 'computer stopped' });
  });
});
