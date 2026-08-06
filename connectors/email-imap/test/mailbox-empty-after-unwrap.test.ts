/**
 * Enveloped-but-empty mailbox names must fail CLOSED. Schema validation
 * (`z.string().trim().min(1)` / `z.string().min(1)`) runs BEFORE the
 * untrusted-content envelope is stripped, so an envelope with empty inner
 * content passes the schema as dozens of non-blank characters and would
 * otherwise reach the network as an empty mailbox name. The non-empty check
 * must run post-unwrap, on the value actually sent to the server.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const { MockImapFlow, calls } = createImapMock({
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

/** Passes every mailbox-name schema (non-blank), unwraps to an empty string. */
const ENVELOPED_EMPTY = '<untrusted-content source="external-email"></untrusted-content>';

describe('mailbox names — empty after envelope unwrap fails closed', () => {
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

  it('email_create_mailbox never sends an empty name to the server', async () => {
    await setupClient();
    const before = calls.mailboxCreate;

    const result = await testClient.callTool('email_create_mailbox', {
      name: ENVELOPED_EMPTY,
    });

    expect(result.isError).toBe(true);
    expect(calls.mailboxCreate).toBe(before);
  });

  it('email_delete_mailbox never sends an empty name to the server', async () => {
    await setupClient();
    const before = calls.mailboxDelete;

    const result = await testClient.callTool('email_delete_mailbox', {
      name: ENVELOPED_EMPTY,
    });

    expect(result.isError).toBe(true);
    expect(calls.mailboxDelete).toBe(before);
  });

  it('email_rename_mailbox rejects an enveloped-empty old or new name', async () => {
    await setupClient();
    const before = calls.mailboxRename;

    const resultOld = await testClient.callTool('email_rename_mailbox', {
      old_name: ENVELOPED_EMPTY,
      new_name: 'Invoices',
    });
    const resultNew = await testClient.callTool('email_rename_mailbox', {
      old_name: 'Receipts',
      new_name: ENVELOPED_EMPTY,
    });

    expect(resultOld.isError).toBe(true);
    expect(resultNew.isError).toBe(true);
    expect(calls.mailboxRename).toBe(before);
  });

  it('email_search_messages rejects an enveloped-empty mailbox', async () => {
    await setupClient();

    const result = await testClient.callTool('email_search_messages', {
      mailbox: ENVELOPED_EMPTY,
    });

    expect(result.isError).toBe(true);
  });

  it('legitimate enveloped mailbox names still round-trip', async () => {
    await setupClient();

    const result = await testClient.callTool('email_search_messages', {
      mailbox: '<untrusted-content source="external-email">INBOX</untrusted-content>',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});
