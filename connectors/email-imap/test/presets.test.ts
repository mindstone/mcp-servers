import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';

const { MockImapFlow } = createImapMock();
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Provider presets', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('icloud preset configures successfully and returns iCloud Mail name', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-app-pass',
      provider: 'icloud',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.provider).toBe('icloud');
    expect(json.message).toContain('iCloud Mail');
  });

  it('icloud preset: getPreset returns correct IMAP/SMTP settings', async () => {
    // Direct test of the presets module
    vi.resetModules();
    const { getPreset } = await import('../src/presets.js');

    const icloudPreset = getPreset('icloud');
    expect(icloudPreset).toBeDefined();
    expect(icloudPreset!.imapHost).toBe('imap.mail.me.com');
    expect(icloudPreset!.imapPort).toBe(993);
    expect(icloudPreset!.imapTls).toBe(true);
    expect(icloudPreset!.smtpHost).toBe('smtp.mail.me.com');
    expect(icloudPreset!.smtpPort).toBe(587);
    expect(icloudPreset!.smtpSecure).toBe(false);
  });

  it('yahoo preset configures successfully and returns Yahoo Mail name', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@yahoo.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'yahoo',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@yahoo.com',
      password: 'test-app-pass',
      provider: 'yahoo',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.provider).toBe('yahoo');
    expect(json.message).toContain('Yahoo Mail');
  });

  it('yahoo preset: getPreset returns correct IMAP/SMTP settings', async () => {
    vi.resetModules();
    const { getPreset } = await import('../src/presets.js');

    const yahooPreset = getPreset('yahoo');
    expect(yahooPreset).toBeDefined();
    expect(yahooPreset!.imapHost).toBe('imap.mail.yahoo.com');
    expect(yahooPreset!.imapPort).toBe(993);
    expect(yahooPreset!.imapTls).toBe(true);
    expect(yahooPreset!.smtpHost).toBe('smtp.mail.yahoo.com');
    expect(yahooPreset!.smtpPort).toBe(465);
    expect(yahooPreset!.smtpSecure).toBe(true);
  });

  it('custom provider uses user-supplied IMAP/SMTP settings', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@fastmail.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'custom',
        EMAIL_IMAP_IMAP_HOST: 'imap.fastmail.com',
        EMAIL_IMAP_IMAP_PORT: '993',
        EMAIL_IMAP_SMTP_HOST: 'smtp.fastmail.com',
        EMAIL_IMAP_SMTP_PORT: '465',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@fastmail.com',
      password: 'test-app-pass',
      provider: 'custom',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    // Custom provider configured — now verify it can perform an operation
    const listResult = await testClient.callTool('email_list_mailboxes', {});
    expect(listResult.isError).toBeFalsy();
  });

  it('unsupported provider returns error', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@example.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@example.com',
      password: 'test-pass',
      // Use a provider name that is genuinely not in `presets.ts` (M3.4
      // added gmail/outlook to the preset list, so they are no longer
      // suitable as "unsupported" examples here).
      provider: 'aol',
    });

    expect(result.isError).toBe(true);
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Unsupported provider');
    expect(json.code).toBe('INVALID_PROVIDER');
  });

  it('EMAIL_IMAP_PROVIDER env var selects provider when arg omitted', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@yahoo.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'yahoo',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@yahoo.com',
      password: 'test-app-pass',
      // No provider arg — should use env var
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.provider).toBe('yahoo');
  });
});
