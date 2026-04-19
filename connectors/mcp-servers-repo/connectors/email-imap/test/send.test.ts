import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const { MockImapFlow } = createImapMock({ mailboxes: createMailboxes() });
const { createTransport: mockCreateTransport, mockTransport, streamTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Send/draft tools', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  async function setupClient() {
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
    return testClient;
  }

  describe('email_send', () => {
    it('sends an email and returns messageId', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'Test subject',
        text: 'Hello, this is a test email.',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.messageId).toBeDefined();
      expect(typeof json.messageId).toBe('string');
    });

    it('sends to multiple recipients', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: ['a@example.com', 'b@example.com'],
        subject: 'Multi-recipient test',
        text: 'Hello all',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('sends with cc and bcc', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'CC/BCC test',
        text: 'Body',
        cc: 'cc@example.com',
        bcc: ['bcc1@example.com', 'bcc2@example.com'],
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('sends a reply with reply_to_message_id', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'original-sender@example.com',
        subject: 'Re: Original Subject',
        text: 'Reply body',
        reply_to_message_id: '<original-123@example.com>',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('validates to is required', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        subject: 'No recipient',
        text: 'Body',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('email_save_draft', () => {
    it('saves a draft and returns messageId and mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_save_draft', {
        to: 'draft-recipient@example.com',
        subject: 'Draft subject',
        text: 'Draft body content',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.messageId).toBeDefined();
      expect(json.mailbox).toBeDefined();
    });

    it('requires at least subject or body', async () => {
      await setupClient();

      const result = await testClient.callTool('email_save_draft', {
        to: 'someone@example.com',
      });
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.error).toContain('subject or a text/html body');
    });
  });
});
