import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

const BASE_SCOPE = 'Mail.ReadWrite Mail.Send offline_access';
const MAILBOX_SCOPE = `MailboxSettings.ReadWrite ${BASE_SCOPE}`;

describe('automatic replies with MailboxSettings permission', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir({ scope: MAILBOX_SCOPE });
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('get_automatic_replies returns the enveloped configuration', async () => {
    const result = await client.callTool('get_automatic_replies', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      ok?: unknown;
      status: string;
      externalAudience: string;
      internalReplyMessage: string;
    };
    expect(json.ok).toBeUndefined();
    expect(json.status).toBe('alwaysEnabled');
    expect(json.externalAudience).toBe('contactsOnly');
    expect(json.internalReplyMessage).toContain('<untrusted-content');
    expect(json.internalReplyMessage).toContain('I am away this week.');
    const call = state.requests.find((r) =>
      r.pathname.endsWith('/me/mailboxSettings/automaticRepliesSetting'),
    );
    expect(call?.method).toBe('GET');
  });

  it('a ZodError whose invalid_enum received echoes the InefficientFilter phrase still takes the schema-validation branch', async () => {
    // Regression: ZodError.message serializes its issues, and an invalid_enum
    // issue embeds the upstream `received` value. A poisoned enum carrying
    // "sort order is too complex" must not be misclassified as Graph's
    // InefficientFilter rejection (which would skip the Zod sanitizer).
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.get('https://graph.microsoft.com/v1.0/me/mailboxSettings/automaticRepliesSetting', () =>
        HttpResponse.json({
          status: 'The restriction or sort order is too complex for this operation.',
        }),
      ),
    );
    const result = await client.callTool('get_automatic_replies', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; action_required?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('failed schema validation');
    const fullText = `${json.error} ${json.action_required ?? ''}`;
    expect(fullText).not.toContain('Simplify or remove');
    // The poisoned upstream value must never echo into model-visible text.
    expect(fullText).not.toContain('sort order is too complex');
  });

  it('set_automatic_replies patches mailboxSettings with the setting', async () => {
    const result = await client.callTool('set_automatic_replies', {
      status: 'alwaysEnabled',
      internalReplyMessage: 'Out until Friday.',
      externalAudience: 'all',
      externalReplyMessage: 'Away.',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { ok?: unknown; status: string };
    expect(json.ok).toBeUndefined();
    expect(json.status).toBe('alwaysEnabled');
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/mailboxSettings'),
    );
    expect(call?.body).toMatchObject({
      automaticRepliesSetting: {
        status: 'alwaysEnabled',
        internalReplyMessage: 'Out until Friday.',
        externalAudience: 'all',
        externalReplyMessage: 'Away.',
      },
    });
  });

  it('set_automatic_replies scheduled converts the window to zone-less UTC', async () => {
    const result = await client.callTool('set_automatic_replies', {
      status: 'scheduled',
      scheduledStart: '2026-08-10T09:00:00Z',
      scheduledEnd: '2026-08-14T18:00:00Z',
      internalReplyMessage: 'Away.',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/mailboxSettings'),
    );
    expect(call?.body).toMatchObject({
      automaticRepliesSetting: {
        status: 'scheduled',
        // Graph's dateTimeTimeZone pairs a zone-less wall-clock string with
        // the declared timeZone, so UTC instants are sent without "Z".
        scheduledStartDateTime: { dateTime: '2026-08-10T09:00:00', timeZone: 'UTC' },
        scheduledEndDateTime: { dateTime: '2026-08-14T18:00:00', timeZone: 'UTC' },
      },
    });
  });

  it('set_automatic_replies scheduled converts explicit offsets to UTC', async () => {
    const result = await client.callTool('set_automatic_replies', {
      status: 'scheduled',
      scheduledStart: '2026-08-10T09:00:00+02:00',
      scheduledEnd: '2026-08-14T18:00:00+02:00',
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'PATCH' && r.pathname.endsWith('/me/mailboxSettings'),
    );
    expect(call?.body).toMatchObject({
      automaticRepliesSetting: {
        scheduledStartDateTime: { dateTime: '2026-08-10T07:00:00', timeZone: 'UTC' },
        scheduledEndDateTime: { dateTime: '2026-08-14T16:00:00', timeZone: 'UTC' },
      },
    });
  });

  it('set_automatic_replies scheduled rejects non-ISO datetimes without calling Graph', async () => {
    const result = await client.callTool('set_automatic_replies', {
      status: 'scheduled',
      scheduledStart: 'next Monday',
      scheduledEnd: '2026-08-14T18:00:00Z',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('scheduledStart');
    expect(
      state.requests.some((r) => r.method === 'PATCH' && r.pathname.endsWith('/me/mailboxSettings')),
    ).toBe(false);
  });

  it('set_automatic_replies scheduled requires start before end', async () => {
    const result = await client.callTool('set_automatic_replies', {
      status: 'scheduled',
      scheduledStart: '2026-08-14T18:00:00Z',
      scheduledEnd: '2026-08-10T09:00:00Z',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('earlier than');
    expect(
      state.requests.some((r) => r.method === 'PATCH' && r.pathname.endsWith('/me/mailboxSettings')),
    ).toBe(false);
  });

  it('set_automatic_replies surfaces a Graph 403 (stale token scope) without re-auth guidance', async () => {
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.patch(
        'https://graph.microsoft.com/v1.0/me/mailboxSettings',
        () =>
          HttpResponse.json(
            { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
            { status: 403 },
          ),
      ),
    );
    const result = await client.callTool('set_automatic_replies', { status: 'disabled' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; action_required?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Access is denied');
    // The upstream detail is attacker-influenceable text: it must arrive
    // inside an untrusted-content envelope.
    expect(json.error).toContain('<untrusted-content source="microsoft-mail:graph-error">');
    // A 403 here is a permissions problem on the Graph side; nothing in the
    // response may prescribe re-authentication or reconnection as the fix.
    const fullText = `${json.error} ${json.action_required ?? ''}`;
    expect(fullText).not.toMatch(/run authenticate_microsoft_account/i);
    expect(fullText).not.toContain('disconnecting and reconnecting');
    expect(fullText).not.toContain('please reconnect');
    // It must instead say plainly that re-authenticating will not help.
    expect(json.error).toContain('re-authenticating the same account will not change that');
  });

  it('set_automatic_replies scheduled without a window returns guidance', async () => {
    const result = await client.callTool('set_automatic_replies', { status: 'scheduled' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('scheduledStart');
  });

  it('set_automatic_replies without status returns guidance', async () => {
    const result = await client.callTool('set_automatic_replies', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter');
  });
});

describe('automatic replies with MailboxSettings.Read only', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir({
      scope: `MailboxSettings.Read ${BASE_SCOPE}`,
    });
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('get_automatic_replies is allowed with the read scope', async () => {
    const result = await client.callTool('get_automatic_replies', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as { status: string };
    expect(json.status).toBe('alwaysEnabled');
  });

  it('set_automatic_replies still requires the ReadWrite scope', async () => {
    const result = await client.callTool('set_automatic_replies', { status: 'disabled' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('MailboxSettings.ReadWrite');
  });
});

describe('automatic replies without MailboxSettings permission', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir({ scope: BASE_SCOPE });
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('get_automatic_replies returns scope guidance instead of calling Graph', async () => {
    const result = await client.callTool('get_automatic_replies', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('MailboxSettings');
    expect(json.next_step).toBe('authenticate_microsoft_account');
  });

  it('set_automatic_replies returns admin-consent-aware guidance', async () => {
    const result = await client.callTool('set_automatic_replies', { status: 'disabled' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; action_required: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('MailboxSettings.ReadWrite');
    expect(json.action_required).toContain('administrator');
  });
});
