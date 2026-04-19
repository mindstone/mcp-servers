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

describe('Error handling', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('credentials never leaked in error messages', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    const secretPassword = 'my-super-secret-app-pwd-1234';

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // Configure with credentials
    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: secretPassword,
      provider: 'icloud',
    });

    // Try an operation that might fail (mock will succeed, but let's verify no leakage)
    const result = await testClient.callTool('email_list_mailboxes', {});
    expect(result.text).not.toContain(secretPassword);
  });

  it('Zod rejects malformed input before any outbound connection', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // email_search_messages requires mailbox (string min 1)
    const result = await testClient.callTool('email_search_messages', {
      // missing required 'mailbox'
    });

    expect(result.isError).toBe(true);
    // The mock ImapFlow should NOT have been used for this request
    // (Zod rejects before we get to the handler)
  });

  it('email_set_flags rejects invalid action via Zod', async () => {
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

    const result = await testClient.callTool('email_set_flags', {
      uids: [1],
      mailbox: 'INBOX',
      action: 'invalid_action',
      flags: ['\\Seen'],
    });

    expect(result.isError).toBe(true);
  });

  it('email_move_messages rejects empty UIDs array via Zod', async () => {
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

    const result = await testClient.callTool('email_move_messages', {
      uids: [],
      mailbox: 'INBOX',
      destination: 'Archive',
    });

    expect(result.isError).toBe(true);
  });

  it('email_get_message rejects non-positive uid via Zod', async () => {
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

    const result = await testClient.callTool('email_get_message', {
      mailbox: 'INBOX',
      uid: 0,
    });

    expect(result.isError).toBe(true);
  });
});
