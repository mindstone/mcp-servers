/**
 * Result-set bounds — email_search_messages must NOT return the entire
 * mailbox when `limit` is omitted (a sane default cap applies, with the
 * truncation observable via `hasMore`/`nextBeforeUid`), and
 * email_list_drafts must be bounded the same way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock, type MockMessageData } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const MESSAGE_COUNT = 60;
const bigMailbox: MockMessageData[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
  uid: 1001 + i,
  envelope: {
    subject: `Message ${1001 + i}`,
    from: [{ name: 'Sender', address: 'sender@example.com' }],
    to: [{ name: 'Test User', address: 'test@icloud.com' }],
    date: new Date('2026-01-15T10:00:00Z'),
    messageId: `<msg-${1001 + i}@example.com>`,
  },
  flags: new Set(['\\Seen']),
  bodyStructure: { type: 'text/plain', part: '1' },
}));

const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: bigMailbox,
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('result-set bounds (default caps)', () => {
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

  it('email_search_messages without limit returns the default page, not the entire mailbox', async () => {
    await setupClient();

    const result = await testClient.callTool('email_search_messages', {
      mailbox: 'INBOX',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const messages = json.messages as Array<{ uid: number }>;
    expect(messages.length).toBe(50);
    expect(messages.length).toBeLessThan(MESSAGE_COUNT);
    // Truncation is observable: hasMore + a usable cursor for the next page.
    expect(json.hasMore).toBe(true);
    expect(json.nextBeforeUid).toBe(messages[messages.length - 1]!.uid);
  });

  it('an explicit limit larger than the default still applies', async () => {
    await setupClient();

    const result = await testClient.callTool('email_search_messages', {
      mailbox: 'INBOX',
      limit: 60,
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    const messages = json.messages as Array<{ uid: number }>;
    expect(messages.length).toBe(MESSAGE_COUNT);
    expect(json.hasMore).toBeUndefined();
  });

  it('paging with before_uid from a default-capped first page reaches the rest', async () => {
    await setupClient();

    const page1 = await testClient.callTool('email_search_messages', {
      mailbox: 'INBOX',
    });
    const json1 = page1.json as Record<string, unknown>;
    const page2 = await testClient.callTool('email_search_messages', {
      mailbox: 'INBOX',
      before_uid: json1.nextBeforeUid as number,
    });
    const json2 = page2.json as Record<string, unknown>;
    const remaining = json2.messages as Array<{ uid: number }>;
    expect(remaining.length).toBe(MESSAGE_COUNT - 50);
    expect(json2.hasMore).toBeUndefined();
  });

  it('email_list_drafts is bounded and reports hasMore', async () => {
    await setupClient();

    const result = await testClient.callTool('email_list_drafts', {});
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const drafts = json.drafts as Array<{ uid: number }>;
    expect(drafts.length).toBe(50);
    expect(drafts.length).toBeLessThan(MESSAGE_COUNT);
    expect(json.hasMore).toBe(true);
  });
});
