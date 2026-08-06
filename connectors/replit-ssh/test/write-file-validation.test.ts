/**
 * replit_write_file with encoding "base64" must reject malformed base64
 * instead of letting Node's decoder silently discard invalid characters
 * (which would write corrupted bytes while the read-back verification —
 * comparing against the same mis-decoded buffer — still reported
 * verified: true).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/ssh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh.js')>();
  return {
    ...actual,
    // Validation must run before any key resolution / network access; this
    // sentinel proves whether a call got past the validation stage.
    preflightChecks: () => ({
      error: JSON.stringify({ ok: false, code: 'PREFLIGHT_SENTINEL', error: 'reached preflight' }),
    }),
  };
});

import { replitWriteFile } from '../src/tools/writeFile.js';

const baseArgs = { host: 'h.replit.dev', user: 'u', path: 'bin.dat' };

async function call(content: string): Promise<{ ok: boolean; code: string; error: string }> {
  const raw = await replitWriteFile({ ...baseArgs, content, encoding: 'base64' });
  return JSON.parse(raw) as { ok: boolean; code: string; error: string };
}

describe('replit_write_file base64 validation', () => {
  it('rejects content with characters outside the base64 alphabet', async () => {
    const res = await call('aGVsbG8!!!d29ybGQ=');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not valid base64');
  });

  it('rejects content with malformed padding', async () => {
    const res = await call('aGVsbG8=d29ybGQ=');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not valid base64');
  });

  it('rejects a length that is not a multiple of 4', async () => {
    const res = await call('aGVsbG');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not valid base64');
  });

  it('accepts well-formed base64 (proceeds past validation to preflight)', async () => {
    const res = await call('aGVsbG8gd29ybGQ=');
    expect(res.code).toBe('PREFLIGHT_SENTINEL');
  });

  it('tolerates line-wrapped base64 (whitespace is stripped)', async () => {
    const res = await call('aGVs\nbG8g\nd29ybGQ=');
    expect(res.code).toBe('PREFLIGHT_SENTINEL');
  });

  it('accepts an empty payload (writes an empty file)', async () => {
    const res = await call('');
    expect(res.code).toBe('PREFLIGHT_SENTINEL');
  });
});
