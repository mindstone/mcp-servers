/**
 * email_delete — a failed move to Trash must be OBSERVABLE and must never
 * silently escalate into a permanent \\Deleted + expunge. The messages stay
 * in place and the tool reports a structured failure.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const { MockImapFlow, calls } = createImapMock({
  mailboxes: createMailboxes(),
  messages: createMessages(),
  searchUids: [101, 102, 103],
  moveError: 'NO Mailbox is locked by another session',
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('email_delete — Trash move failure', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('aborts observably without expunging when the Trash move throws', async () => {
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

    const deleteCallsBefore = calls.messageDelete;
    const flagCallsBefore = calls.messageFlagsAdd;

    const result = await testClient.callTool('email_delete', {
      uids: [101],
      mailbox: 'INBOX',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('TRASH_MOVE_FAILED');
    expect(json.error as string).toContain('nothing was deleted');

    // The permanent path must NOT have run: no \Deleted flag, no expunge.
    expect(calls.messageDelete).toBe(deleteCallsBefore);
    expect(calls.messageFlagsAdd).toBe(flagCallsBefore);
  });
});
