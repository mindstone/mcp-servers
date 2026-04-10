import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

// Create mocks with test data
const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: createMessages(),
  searchUids: [101, 102, 103],
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Mailbox tools', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('email_list_mailboxes returns all mailboxes with counts', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // Configure first
    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-pass',
      provider: 'icloud',
    });

    const result = await testClient.callTool('email_list_mailboxes', {});
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);

    const mailboxes = json.mailboxes as Array<Record<string, unknown>>;
    expect(mailboxes.length).toBeGreaterThanOrEqual(4);

    const inbox = mailboxes.find((m) => m.name === 'INBOX');
    expect(inbox).toBeDefined();
    expect(inbox!.messages).toBe(10);
    expect(inbox!.unseen).toBe(3);
  });

  it('email_get_mailbox_status returns status for INBOX', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-pass',
      provider: 'icloud',
    });

    const result = await testClient.callTool('email_get_mailbox_status', {
      mailbox: 'INBOX',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.mailbox).toBe('INBOX');
    expect(json.total).toBe(10);
    expect(json.unread).toBe(3);
  });

  it('email_get_mailbox_status defaults to INBOX when no mailbox provided', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-pass',
      provider: 'icloud',
    });

    const result = await testClient.callTool('email_get_mailbox_status', {});
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.mailbox).toBe('INBOX');
  });

  it('email_get_mailbox_status with includeLatest returns unread messages', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-pass',
      provider: 'icloud',
    });

    const result = await testClient.callTool('email_get_mailbox_status', {
      mailbox: 'INBOX',
      includeLatest: true,
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.latestUnread).toBeDefined();
  });
});
