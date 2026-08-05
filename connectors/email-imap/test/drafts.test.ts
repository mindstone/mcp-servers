/**
 * Draft management tools — email_list_drafts, email_update_draft,
 * email_delete_draft.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

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

describe('Draft tools', () => {
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

  describe('email_list_drafts', () => {
    it('lists drafts from the resolved Drafts mailbox with wrapped summaries', async () => {
      await setupClient();

      const result = await testClient.callTool('email_list_drafts', {});
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.mailbox).toBe(
        '<untrusted-content source="external-email">Drafts</untrusted-content>',
      );
      const drafts = json.drafts as Array<Record<string, unknown>>;
      expect(drafts.length).toBe(3);
      expect(drafts.map((d) => d.uid)).toEqual([103, 102, 101]);
      for (const draft of drafts) {
        expect(draft.subject as string).toMatch(
          /^<untrusted-content source="external-email">/,
        );
      }
    });
  });

  describe('email_update_draft', () => {
    it('appends the replacement draft and expunges the old one', async () => {
      await setupClient();

      const result = await testClient.callTool('email_update_draft', {
        uid: 101,
        subject: 'Updated subject',
        text: 'Updated body',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.mailbox).toBe(
        '<untrusted-content source="external-email">Drafts</untrusted-content>',
      );
      expect(json.replacedUid).toBe(101);
      expect(typeof json.messageId).toBe('string');
      // Mock append() reports uid 999 for the new draft.
      expect(json.uid).toBe(999);
    });

    it('requires at least a subject or a body', async () => {
      await setupClient();

      const result = await testClient.callTool('email_update_draft', {
        uid: 101,
      });
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.error as string).toContain('at least a subject or a text/html body');
    });

    it('validates uid must be a positive integer', async () => {
      await setupClient();

      const result = await testClient.callTool('email_update_draft', {
        uid: 0,
        subject: 'x',
      });
      expect(result.isError).toBe(true);
    });

    it('is annotated destructiveHint: true (replaces and expunges a draft)', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_update_draft');
      expect(entry, 'email_update_draft must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });
  });

  describe('email_delete_draft', () => {
    it('permanently deletes a draft from the Drafts mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_delete_draft', { uid: 101 });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deleted).toBe(1);
      expect(json.mailbox).toBe(
        '<untrusted-content source="external-email">Drafts</untrusted-content>',
      );
    });

    it('is annotated destructiveHint: true', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_delete_draft');
      expect(entry, 'email_delete_draft must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });
  });
});
