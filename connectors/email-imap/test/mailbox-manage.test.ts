/**
 * Mailbox management tools — email_create_mailbox, email_rename_mailbox,
 * email_delete_mailbox (INBOX protection, destructive annotation).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: createMessages(),
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Mailbox management tools', () => {
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

  describe('email_create_mailbox', () => {
    it('creates a mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_create_mailbox', {
        name: 'Receipts',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.created).toBe('Receipts');
    });

    it('refuses to create INBOX', async () => {
      await setupClient();

      const result = await testClient.callTool('email_create_mailbox', {
        name: 'inbox',
      });
      expect(result.isError).toBe(true);
    });

    it('is annotated destructiveHint: true (remote mailbox mutation)', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_create_mailbox');
      expect(entry, 'email_create_mailbox must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });

    it('validates name is required', async () => {
      await setupClient();

      const result = await testClient.callTool('email_create_mailbox', {});
      expect(result.isError).toBe(true);
    });

    it('rejects a whitespace-only name via schema validation (never reaches IMAP)', async () => {
      await setupClient();

      const result = await testClient.callTool('email_create_mailbox', {
        name: '   ',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('email_rename_mailbox', () => {
    it('renames a mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_rename_mailbox', {
        old_name: 'Receipts',
        new_name: 'Invoices',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.renamed).toEqual({ from: 'Receipts', to: 'Invoices' });
    });

    it('refuses to rename INBOX', async () => {
      await setupClient();

      const result = await testClient.callTool('email_rename_mailbox', {
        old_name: 'INBOX',
        new_name: 'Inbox2',
      });
      expect(result.isError).toBe(true);
    });

    it('refuses INBOX as the rename target', async () => {
      await setupClient();

      const result = await testClient.callTool('email_rename_mailbox', {
        old_name: 'Receipts',
        new_name: 'INBOX',
      });
      expect(result.isError).toBe(true);
    });

    it('rejects whitespace-only names via schema validation (never reaches IMAP)', async () => {
      await setupClient();

      const result = await testClient.callTool('email_rename_mailbox', {
        old_name: 'Receipts',
        new_name: '\t\n ',
      });
      expect(result.isError).toBe(true);
    });

    it('is annotated destructiveHint: true (remote mailbox mutation)', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_rename_mailbox');
      expect(entry, 'email_rename_mailbox must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });
  });

  describe('email_delete_mailbox', () => {
    it('deletes a mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_delete_mailbox', {
        name: 'Receipts',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deleted).toBe('Receipts');
    });

    it('refuses to delete INBOX', async () => {
      await setupClient();

      const result = await testClient.callTool('email_delete_mailbox', {
        name: 'INBOX',
      });
      expect(result.isError).toBe(true);
    });

    it('is annotated destructiveHint: true', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_delete_mailbox');
      expect(entry, 'email_delete_mailbox must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });
  });
});
