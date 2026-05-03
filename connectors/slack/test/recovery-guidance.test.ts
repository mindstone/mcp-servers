/**
 * ConnectorError → tool response invariant.
 *
 * Every error path that throws a `ConnectorError` MUST surface a `next_step`
 * field in the JSON response so the recovery-guidance contract holds. The
 * default `next_step` is derived from `DEFAULT_NEXT_STEP_BY_CODE` if the
 * throw-site doesn't supply one explicitly. (Stage 1 round-1 review fix.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

const CLIENT_ENV = {
  SLACK_CLIENT_ID: 'mock-client-id',
  SLACK_CLIENT_SECRET: 'mock-client-secret',
  SLACK_TEAM_ID: 'T123',
};

describe('ConnectorError → next_step contract', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('CHANNEL_NOT_FOUND surfaces next_step=list_slack_channels via default mapping', async () => {
    // resolveChannelId iterates conversations.list (mocked to return only
    // "general") and throws ConnectorError('CHANNEL_NOT_FOUND') for any
    // unknown name. The default-next-step map maps it to list_slack_channels.
    const result = await client.callTool('get_slack_channel_history', {
      channel: '#does-not-exist',
      limit: 1,
    });
    const j = result.json as {
      ok?: boolean;
      code?: string;
      action_required?: string;
      next_step?: string;
    };
    expect(j.ok).toBe(false);
    expect(j.code).toBe('CHANNEL_NOT_FOUND');
    // The recovery-guidance contract: next_step MUST be set on every error.
    expect(j.next_step).toBeTruthy();
    expect(j.next_step).toBe('list_slack_channels');
    expect(j.action_required).toBeTruthy();
  });

  it('ConnectorError instances always carry a nextStep — explicit or defaulted', async () => {
    // Direct ConnectorError construction via the same env path the runtime
    // uses. Confirms the property is set whether or not nextStep is supplied.
    const { ConnectorError, DEFAULT_NEXT_STEP_BY_CODE } = await import('../src/types.js');

    const explicit = new ConnectorError('msg', 'CHANNEL_NOT_FOUND', 'res', undefined, 'override');
    expect(explicit.nextStep).toBe('override');

    const defaulted = new ConnectorError('msg', 'CHANNEL_NOT_FOUND', 'res');
    expect(defaulted.nextStep).toBe(DEFAULT_NEXT_STEP_BY_CODE.CHANNEL_NOT_FOUND);
    expect(defaulted.nextStep).toBe('list_slack_channels');

    const fallback = new ConnectorError('msg', 'UNKNOWN_CODE', 'res');
    // Unknown codes fall back to the safe `list_slack_workspaces` next step.
    expect(fallback.nextStep).toBe('list_slack_workspaces');
  });
});

describe('sanitizeErrorMessage — token / secret redaction', () => {
  it('redacts xoxb-/xoxp-/xapp- tokens', async () => {
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    expect(sanitizeErrorMessage('error with xoxb-1234-fake-token in it')).not.toContain(
      'xoxb-1234-fake-token',
    );
    expect(sanitizeErrorMessage('xoxp-secret-user-token')).not.toContain('xoxp-secret-user-token');
    expect(sanitizeErrorMessage('xapp-app-level-token-here')).not.toContain('xapp-app-level-token-here');
    expect(sanitizeErrorMessage('xoxe-1-refresh-secret')).not.toContain('xoxe-1-refresh-secret');
  });

  it('redacts Authorization: Bearer headers', async () => {
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    const out = sanitizeErrorMessage('upstream returned: Authorization: Bearer abcdef.GHIJKL_xyz-/+=');
    expect(out).not.toContain('abcdef.GHIJKL_xyz-/+=');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts long opaque secrets (≥32 chars of base64-ish content)', async () => {
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    const secret = 'a'.repeat(64);
    expect(sanitizeErrorMessage(`oops ${secret} oops`)).not.toContain(secret);
  });

  it('preserves the surrounding error context for debuggability', async () => {
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    const out = sanitizeErrorMessage('Slack API auth failed for token xoxb-1234-fake — retry later.');
    expect(out).toContain('Slack API auth failed for token');
    expect(out).toContain('retry later.');
    expect(out).not.toContain('xoxb-1234-fake');
  });

  it('error responses do not leak tokens — full pipeline through withErrorHandling', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const handler = withErrorHandling(async () => {
      throw new Error('upstream blew up: xoxb-9999-extremely-secret-token AAAA');
    });
    const result = await handler({}, {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('xoxb-9999-extremely-secret-token');
    expect(text).toContain('[REDACTED]');
  });
});

describe('sanitizeErrorMessage — round-3 hardening (URL-encoded + extra)', () => {
  it('redacts URL-encoded variants of credentials (round 2 security finding)', async () => {
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    const encoded = 'config: xoxb%2Dsecret%2Dwith%2Dencoded-dashes ok';
    expect(sanitizeErrorMessage(encoded)).not.toContain('xoxb%2Dsecret');
    expect(sanitizeErrorMessage(encoded)).toContain('[REDACTED]');

    const bearer = 'header: Bearer%20encoded%2Dtoken%2Dvalue end';
    expect(sanitizeErrorMessage(bearer)).not.toContain('encoded%2Dtoken%2Dvalue');
    expect(sanitizeErrorMessage(bearer)).toContain('[REDACTED]');
  });

  it('redacts FULLY url-encoded Slack tokens — round-3 reviewer finding (multiple %2D segments)', async () => {
    // Reviewers (GPT, lens-security) flagged that the original round-3 regex
    // only handled the FIRST %2D and left tail segments unredacted. This test
    // pins the fix: encoded hyphens must be consumed throughout the token body.
    const { sanitizeErrorMessage } = await import('../src/utils.js');
    const fullyEncoded = 'config: xoxb%2D123%2D456%2D789secret end';
    const out = sanitizeErrorMessage(fullyEncoded);
    expect(out).not.toContain('xoxb%2D123');
    expect(out).not.toContain('%2D456');
    expect(out).not.toContain('%2D789secret');
    expect(out).toContain('[REDACTED]');
    // Surrounding context must survive (debuggability).
    expect(out).toContain('config:');
    expect(out).toContain('end');

    // Also xapp variant.
    const xapp = 'token: xapp%2DAAA%2DBBB%2DCCC done';
    const outXapp = sanitizeErrorMessage(xapp);
    expect(outXapp).not.toContain('xapp%2DAAA');
    expect(outXapp).not.toContain('%2DBBB');
    expect(outXapp).toContain('[REDACTED]');
    expect(outXapp).toContain('done');
  });

  it('sanitizeExtraDeep returns a placeholder beyond depth cap instead of raw value (no deep-secret leak)', async () => {
    // Build an object deeper than the cap (>6 levels) with a secret at the
    // bottom. The deep-cap branch must NOT pass the raw value through.
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const deep: Record<string, unknown> = { secret: 'xoxb-deep-leak-token-AAA' };
    let nested: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i++) nested = { wrap: nested };
    const handler = withErrorHandling(async () => {
      throw new ConnectorError('x', 'RATE_LIMITED', 'r', { tree: nested });
    });
    const result = await handler({}, {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('xoxb-deep-leak-token-AAA');
    expect(text).toContain('[REDACTED-DEPTH-EXCEEDED]');
  });

  it('sanitizeExtraDeep handles BigInt without throwing in JSON.stringify (MED-6)', async () => {
    // Without the BigInt branch, JSON.stringify on a sanitized BigInt leaf
    // throws and breaks the whole error pipeline (the response constructor
    // crashes mid-stringify). Verify the response is well-formed and
    // contains the BigInt rendered as a string.
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError('bigint extra', 'RATE_LIMITED', 'wait', { biggie: 100n });
    });
    const result = await handler({}, {});
    const text = (result.content[0] as { text: string }).text;
    // Must not have thrown — JSON must be parseable.
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('RATE_LIMITED');
    expect(parsed.biggie).toBe('100n');
    expect(text).toContain('100n');
  });

  it('ConnectorError.extra is sanitized AND cannot override canonical fields', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError(
        'rate-limited',
        'RATE_LIMITED',
        'Wait briefly and retry',
        {
          upstreamHeaders: {
            Authorization: 'Bearer xoxb-leaked-token-from-extra-1234567890',
          },
          next_step: 'phishing-redirect',
          code: 'NOT_A_REAL_CODE',
          ok: true,
        },
        'retry_after_delay',
      );
    });
    const result = await handler({}, {});
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(text).not.toContain('xoxb-leaked-token-from-extra-1234567890');
    expect(parsed.upstreamHeaders.Authorization).toContain('[REDACTED]');
    expect(parsed.next_step).toBe('retry_after_delay');
    expect(parsed.code).toBe('RATE_LIMITED');
    expect(parsed.ok).toBe(false);
  });
});

describe('tokenProvider-originated ConnectorError surfaces next_step', () => {
  it('NO_TOKEN from tokenProvider maps to authenticate_slack_workspace', async () => {
    const { ConnectorError, DEFAULT_NEXT_STEP_BY_CODE } = await import('../src/types.js');
    const err = new ConnectorError('No bot token found.', 'NO_TOKEN', 'Please reconnect your Slack workspace.');
    expect(err.nextStep).toBe(DEFAULT_NEXT_STEP_BY_CODE.NO_TOKEN);
    expect(err.nextStep).toBe('authenticate_slack_workspace');
  });

  it('REFRESH_FAILED maps to authenticate_slack_workspace', async () => {
    const { ConnectorError, DEFAULT_NEXT_STEP_BY_CODE } = await import('../src/types.js');
    const err = new ConnectorError('Refresh failed.', 'REFRESH_FAILED', 'Please reconnect.');
    expect(err.nextStep).toBe(DEFAULT_NEXT_STEP_BY_CODE.REFRESH_FAILED);
  });

  it('TOKEN_PERSIST_FAILED maps to retry_after_delay (in-memory tokens still good — do NOT burn refresh)', async () => {
    // Mapping changed in round-4: persistence failure must NOT push the
    // user into reauth, because the rotated tokens are still valid in
    // memory and forcing reauth would burn Slack's single-use refresh
    // token. Retrying gives disk a chance to recover.
    const { ConnectorError } = await import('../src/types.js');
    const err = new ConnectorError('persist failed', 'TOKEN_PERSIST_FAILED', 'cached in memory, retry');
    expect(err.nextStep).toBe('retry_after_delay');
  });
});
