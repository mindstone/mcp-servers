/**
 * Operator-log integrity: tool-supplied paths are validated for traversal
 * but not for control characters, so logOperation must strip them before
 * interpolating into a stderr line — otherwise a path containing "\n" or
 * ANSI escapes forges log entries or injects terminal sequences.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logOperation } from '../src/ssh.js';

describe('logOperation — control-character sanitisation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips newlines so a path cannot forge extra log lines', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logOperation('replit_read_file', 'h.replit.dev', 'a.txt\n[replit-ssh] tool=replit_delete_file path=x result=ok', 'ok', 1);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    // A single log line: the injected newline is gone, so the forged text
    // stays inline in the path field instead of posing as its own entry.
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.startsWith('[replit-ssh] tool=replit_read_file ')).toBe(true);
    expect(line).toContain('path=a.txt');
  });

  it('strips carriage returns and ANSI escape bytes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logOperation('replit_read_file', 'h.replit.dev', 'a\r.txt\x1b[31m', 'error', 2);
    const line = spy.mock.calls[0]![0] as string;
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line).toContain('path=a.txt[31m');
  });

  it('leaves ordinary paths untouched', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logOperation('replit_stat', 'h.replit.dev', 'src/dir/file name.ts', 'ok', 3);
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('path=src/dir/file name.ts');
  });
});
