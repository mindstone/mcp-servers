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

  it('set_automatic_replies scheduled wraps the window in dateTime/timeZone', async () => {
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
        scheduledStartDateTime: { dateTime: '2026-08-10T09:00:00Z', timeZone: 'UTC' },
        scheduledEndDateTime: { dateTime: '2026-08-14T18:00:00Z', timeZone: 'UTC' },
      },
    });
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
