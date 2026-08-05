import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const testMessages = createMessages();
const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: testMessages,
  searchUids: testMessages.map((m) => m.uid),
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Message tools', () => {
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

  describe('email_search_messages', () => {
    it('returns messages from INBOX', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.messages)).toBe(true);
      const messages = json.messages as Array<Record<string, unknown>>;
      expect(messages.length).toBeGreaterThan(0);
    });

    it('returns messages with correct structure', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
      });
      const json = result.json as Record<string, unknown>;
      const messages = json.messages as Array<Record<string, unknown>>;
      const msg = messages[0]!;

      expect(msg).toHaveProperty('uid');
      expect(msg).toHaveProperty('subject');
      expect(msg).toHaveProperty('from');
      expect(msg).toHaveProperty('date');
      expect(msg).toHaveProperty('flags');
    });

    it('validates mailbox is required', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {});
      // Zod will reject missing mailbox
      expect(result.isError).toBe(true);
    });

    it('paginates with limit + before_uid until history is exhausted', async () => {
      await setupClient();

      // Fixture UIDs: 101 (oldest), 102, 103 (newest).
      const page1 = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        limit: 1,
      });
      expect(page1.isError).toBeFalsy();
      const json1 = page1.json as Record<string, unknown>;
      expect((json1.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([103]);
      expect(json1.hasMore).toBe(true);
      expect(json1.nextBeforeUid).toBe(103);

      const page2 = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        limit: 1,
        before_uid: json1.nextBeforeUid,
      });
      const json2 = page2.json as Record<string, unknown>;
      expect((json2.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([102]);
      expect(json2.hasMore).toBe(true);
      expect(json2.nextBeforeUid).toBe(102);

      const page3 = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        limit: 1,
        before_uid: json2.nextBeforeUid,
      });
      const json3 = page3.json as Record<string, unknown>;
      expect((json3.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([101]);
      expect(json3.hasMore).toBeUndefined();
    });

    it('before_uid without limit returns all older messages', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        before_uid: 103,
      });
      const json = result.json as Record<string, unknown>;
      expect((json.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([102, 101]);
      expect(json.hasMore).toBeUndefined();
    });

    it('filters by since date', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        since: '2026-01-16T00:00:00Z',
      });
      const json = result.json as Record<string, unknown>;
      expect((json.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([103, 102]);
    });

    it('filters by before date', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        before: '2026-01-17T00:00:00Z',
      });
      const json = result.json as Record<string, unknown>;
      expect((json.messages as Array<{ uid: number }>).map((m) => m.uid)).toEqual([102, 101]);
    });

    it('rejects an unparseable since date with an actionable error', async () => {
      await setupClient();

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        since: 'not-a-date',
      });
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.error as string).toContain('Invalid "since" date filter');
    });
  });

  describe('email_get_message', () => {
    it('returns full message content by UID', async () => {
      await setupClient();

      const result = await testClient.callTool('email_get_message', {
        mailbox: 'INBOX',
        uid: 101,
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      const message = json.message as Record<string, unknown>;
      expect(message.uid).toBe(101);
      expect(message.subject).toBe(
        '<untrusted-content source="external-email">Welcome to the service</untrusted-content>',
      );
      expect(message.from).toContain('support@example.com');
      expect(message.from as string).toMatch(
        /^<untrusted-content source="external-email">/,
      );
    });

    it('includes attachment metadata', async () => {
      await setupClient();

      const result = await testClient.callTool('email_get_message', {
        mailbox: 'INBOX',
        uid: 102,
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      const message = json.message as Record<string, unknown>;
      const attachments = message.attachments as Array<Record<string, unknown>>;
      expect(attachments.length).toBe(1);
      expect(attachments[0]!.filename).toBe(
        '<untrusted-content source="external-email">agenda.pdf</untrusted-content>',
      );
      expect(attachments[0]!.contentType).toBe(
        '<untrusted-content source="external-email">application/pdf</untrusted-content>',
      );
    });

    it('validates uid must be positive integer', async () => {
      await setupClient();

      const result = await testClient.callTool('email_get_message', {
        mailbox: 'INBOX',
        uid: -1,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('email_move_messages', () => {
    it('moves messages between folders', async () => {
      await setupClient();

      const result = await testClient.callTool('email_move_messages', {
        uids: [101, 102],
        mailbox: 'INBOX',
        destination: 'Archive',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.moved).toBe(2);
    });

    it('validates uids must not be empty', async () => {
      await setupClient();

      const result = await testClient.callTool('email_move_messages', {
        uids: [],
        mailbox: 'INBOX',
        destination: 'Archive',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('email_set_flags', () => {
    it('adds flags to messages', async () => {
      await setupClient();

      const result = await testClient.callTool('email_set_flags', {
        uids: [101],
        mailbox: 'INBOX',
        action: 'add',
        flags: ['\\Seen'],
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.updated).toBe(1);
    });

    it('removes flags from messages', async () => {
      await setupClient();

      const result = await testClient.callTool('email_set_flags', {
        uids: [101, 102],
        mailbox: 'INBOX',
        action: 'remove',
        flags: ['\\Flagged'],
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.updated).toBe(2);
    });

    it('validates action must be add or remove', async () => {
      await setupClient();

      const result = await testClient.callTool('email_set_flags', {
        uids: [101],
        mailbox: 'INBOX',
        action: 'toggle',
        flags: ['\\Seen'],
      });
      expect(result.isError).toBe(true);
    });
  });
});
