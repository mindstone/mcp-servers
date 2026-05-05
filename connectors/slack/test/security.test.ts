/**
 * Security regression tests for the Slack OSS connector.
 *
 * Covers:
 *   - SLACK_TEAM_ID validation: reject path-traversal attempts at provider
 *     construction time (Stage 1 review fix #6).
 *   - Atomic token persistence: a failed `fs.renameSync` must NOT lose the
 *     rotated tokens from in-memory cache, must log a structured error,
 *     and must surface as a thrown `ConnectorError` (Stage 1 review fix #7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('SLACK_TEAM_ID validation — path traversal defence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects ../../etc/passwd at provider construction', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    expect(
      () =>
        new SlackTokenProvider(
          '/tmp/slack-test',
          '../../etc/passwd',
          'mock-client-id',
          'mock-client-secret',
        ),
    ).toThrow(/Invalid SLACK_TEAM_ID/);
  });

  it('rejects empty team IDs', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    expect(
      () => new SlackTokenProvider('/tmp/slack-test', '', 'cid', 'csec'),
    ).toThrow(/Invalid SLACK_TEAM_ID/);
  });

  it('rejects lowercase team IDs (Slack workspace IDs are uppercase)', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    expect(
      () => new SlackTokenProvider('/tmp/slack-test', 't0123abcd', 'cid', 'csec'),
    ).toThrow(/Invalid SLACK_TEAM_ID/);
  });

  it('rejects team IDs containing path separators', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    expect(
      () => new SlackTokenProvider('/tmp/slack-test', 'T123/foo', 'cid', 'csec'),
    ).toThrow(/Invalid SLACK_TEAM_ID/);
    expect(
      () => new SlackTokenProvider('/tmp/slack-test', 'T123\\foo', 'cid', 'csec'),
    ).toThrow(/Invalid SLACK_TEAM_ID/);
  });

  it('accepts a valid Slack workspace ID', async () => {
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    expect(
      () => new SlackTokenProvider('/tmp/slack-test', 'T0123ABCD', 'cid', 'csec'),
    ).not.toThrow();
  });
});

describe('saveTokens — atomic write safety', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps rotated tokens in memory if rename fails, throws, and emits a structured log', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-atomic-'));
    // Place a regular file where the `workspaces/` directory should be.
    // saveTokens calls fs.existsSync('workspaces') which returns true, skips
    // the mkdir, then writeFileSync into 'workspaces/T123.json.tmp...' which
    // fails with ENOTDIR — a realistic mid-write disk error in ESM tests
    // without needing to spy on the native fs namespace.
    fs.writeFileSync(path.join(tmpDir, 'workspaces'), 'placeholder');

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const provider = new SlackTokenProvider(tmpDir, 'T123', 'mock-cid', 'mock-csec');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rotatedTokens = {
      botToken: 'xoxb-rotated',
      botUserId: 'U999BOT',
      botRefreshToken: 'xoxe-1-rotated',
      botExpiresAt: Date.now() + 60_000,
    };

    // saveTokens is private — driving via the refresh path is awkward.
    // Use bracket access to invoke the method directly for this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saveTokens = (provider as any).saveTokens.bind(provider);

    let threw = false;
    try {
      await saveTokens(rotatedTokens);
    } catch (err) {
      threw = true;
      // (c) operation reported as failed via thrown ConnectorError.
      expect((err as { code?: string }).code).toBe('TOKEN_PERSIST_FAILED');
    }
    expect(threw, 'saveTokens must reject on disk failure (silent failure is a bug)').toBe(true);

    // (a) cachedTokens still holds the rotated values — they were cached
    // BEFORE the disk write, so a write failure cannot lose them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((provider as any).cachedTokens).toEqual(rotatedTokens);

    // (b) a structured log was emitted that includes the team ID — operators
    // need to know which workspace stalled.
    const errMessages = consoleErrorSpy.mock.calls
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(errMessages).toContain('Token persist FAILED');
    expect(errMessages).toContain('T123');

    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
