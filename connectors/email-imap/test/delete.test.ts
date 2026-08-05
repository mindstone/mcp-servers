/**
 * email_delete — move-to-Trash (recoverable) with \Deleted+expunge fallback
 * (permanent) ONLY when no Trash mailbox exists or the message is already in
 * it. A FAILED Trash move aborts observably (TRASH_MOVE_FAILED) without
 * expunging — covered in delete-move-failure.test.ts.
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

describe('email_delete', () => {
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

  it('moves messages to the Trash mailbox when one exists', async () => {
    await setupClient();

    const result = await testClient.callTool('email_delete', {
      uids: [101],
      mailbox: 'INBOX',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.deleted).toBe(1);
    expect(json.method).toBe('trash');
    // Fixture trash mailbox: 'Deleted Messages' (specialUse \Trash) — the
    // server-supplied mailbox path is enveloped in the response.
    expect(json.trashMailbox).toBe(
      '<untrusted-content source="external-email">Deleted Messages</untrusted-content>',
    );
  });

  it('expunges permanently when deleting from the Trash mailbox itself', async () => {
    await setupClient();

    const result = await testClient.callTool('email_delete', {
      uids: [101],
      mailbox: 'Deleted Messages',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.method).toBe('expunge');
  });

  it('is annotated destructiveHint: true', async () => {
    await setupClient();

    const tools = await testClient.client.listTools();
    const entry = tools.tools.find((t) => t.name === 'email_delete');
    expect(entry, 'email_delete must be registered').toBeDefined();
    expect(entry!.annotations?.destructiveHint).toBe(true);
  });

  it('validates uids must not be empty', async () => {
    await setupClient();

    const result = await testClient.callTool('email_delete', {
      uids: [],
      mailbox: 'INBOX',
    });
    expect(result.isError).toBe(true);
  });
});
