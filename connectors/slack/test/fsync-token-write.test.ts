/**
 * HIGH-9 — token write must fsync the file descriptor before rename, per
 * § 5.1. Without fsync, a power loss / kernel panic between rename and
 * the journal commit can leave disk holding an empty/partial file even
 * though rename returned successfully.
 *
 * MED-2 — explicit chmod on the FINAL path after rename. The source-mode
 * preservation under rename is not enough if a tokenPath already exists
 * with a different mode (legacy host writers, different umask).
 *
 * Vitest cannot spyOn ESM module-namespace exports (`fs.fsyncSync` is
 * read-only at the binding level), so this test verifies fsync via a
 * proxy: we read the compiled `dist/tokenProvider.js` and assert the
 * call is present in the saveTokens path. End-to-end behavioural
 * verification (file exists with mode 0600 after a successful save) is
 * also covered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const DIST_TOKEN_PROVIDER = path.join(PKG_ROOT, 'dist', 'tokenProvider.js');
const SRC_TOKEN_PROVIDER = path.join(PKG_ROOT, 'src', 'tokenProvider.ts');

describe('saveTokens — fsync + final chmod', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-fsync-'));
    fs.mkdirSync(path.join(tmpDir, 'workspaces'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('source contains fsyncSync call inside saveTokens (HIGH-9 — durability invariant)', () => {
    const src = fs.readFileSync(SRC_TOKEN_PROVIDER, 'utf-8');
    // saveTokens must contain at least one fsyncSync call. The
    // implementation fsyncs the file fd before rename and (best-effort)
    // the parent directory after rename.
    const saveTokensIdx = src.indexOf('saveTokens');
    expect(saveTokensIdx).toBeGreaterThan(-1);
    const fsyncIdx = src.indexOf('fsyncSync', saveTokensIdx);
    expect(fsyncIdx).toBeGreaterThan(saveTokensIdx);
  });

  it('compiled dist/tokenProvider.js carries fsyncSync (rebuild guard)', () => {
    if (!fs.existsSync(DIST_TOKEN_PROVIDER)) {
      // dist/ may be skipped in dev-only test runs; skip rather than fail.
      console.warn('[fsync-token-write] dist/tokenProvider.js missing — run `npm run build`');
      return;
    }
    const dist = fs.readFileSync(DIST_TOKEN_PROVIDER, 'utf-8');
    expect(dist).toContain('fsyncSync');
  });

  it('end-to-end: saved tokens land at mode 0600 on POSIX, even if a pre-existing file had wider perms (MED-2)', async () => {
    if (process.platform === 'win32') return;

    const tokenPath = path.join(tmpDir, 'workspaces', 'T0123ABCD.json');
    // Pre-existing file with broad permissions — simulates a buggy legacy
    // writer or different umask.
    fs.writeFileSync(tokenPath, '{}', { mode: 0o644 });
    fs.chmodSync(tokenPath, 0o644);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o644);

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tp as any).saveTokens({
      botToken: 'xoxb-after',
      botUserId: 'U999',
      botRefreshToken: 'xoxe-1-x',
      botExpiresAt: Date.now() + 60_000,
    });

    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('end-to-end: saved file content is the full payload (proxy for fsync correctness — no partial-write)', async () => {
    const tokenPath = path.join(tmpDir, 'workspaces', 'T0123ABCD.json');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    const tokens = {
      botToken: 'xoxb-fsync-end-to-end',
      botUserId: 'U999',
      botRefreshToken: 'xoxe-1-x',
      botExpiresAt: Date.now() + 60_000,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tp as any).saveTokens(tokens);

    const onDisk = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    expect(onDisk.botToken).toBe('xoxb-fsync-end-to-end');
    expect(onDisk.botRefreshToken).toBe('xoxe-1-x');
  });

  it('source contains writeSync loop guarding against short writes (round-5 review fix)', () => {
    // Round-5 independent reviewer flagged that an unchecked writeSync
    // return value could short-write under signal interruption — the
    // truncated-but-fsynced file would survive rename and surface as
    // TOKEN_FILE_CORRUPT on next load. The fix is a while loop until
    // the entire payload is written.
    const src = fs.readFileSync(SRC_TOKEN_PROVIDER, 'utf-8');
    // Find the actual METHOD declaration, not a comment occurrence — the
    // private async saveTokens(...) signature is unique in the file.
    const methodIdx = src.search(/private\s+async\s+saveTokens\s*\(/);
    expect(methodIdx).toBeGreaterThan(-1);
    // Slice from the method declaration to the end-of-file (the method is
    // near the end of the file; this is a generous upper bound).
    const saveTokensBody = src.slice(methodIdx);
    expect(saveTokensBody).toMatch(/while\s*\(\s*written\s*<\s*buf\.length\s*\)/);
    expect(saveTokensBody).toMatch(/writeSync returned/);
  });

  it('end-to-end: full payload reaches disk for a large token blob (would expose short-write regressions on resource-constrained kernels)', async () => {
    const tokenPath = path.join(tmpDir, 'workspaces', 'T0123ABCD.json');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T0123ABCD', 'cid', 'csec');
    // Synthetic large token-data blob (≈100KB) to push past page-size
    // and any writeSync internal buffering boundaries.
    const big = 'x'.repeat(100_000);
    const tokens = {
      botToken: `xoxb-${big}`,
      botUserId: 'U999',
      botRefreshToken: 'xoxe-1-x',
      botExpiresAt: Date.now() + 60_000,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tp as any).saveTokens(tokens);
    const onDisk = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    expect(onDisk.botToken.length).toBe(`xoxb-${big}`.length);
    expect(onDisk.botToken.endsWith(big.slice(-50))).toBe(true);
  });
});
