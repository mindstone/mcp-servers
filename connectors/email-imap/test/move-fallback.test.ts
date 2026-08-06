/**
 * email_move_messages — when the server has no usable MOVE command, the
 * COPY + expunge-source fallback must only permanently expunge the originals
 * after the copy is VERIFIED complete for every requested UID. A
 * truthy-but-incomplete copy result must abort observably with the messages
 * left in place — the same fail-closed rationale as email_delete's
 * TRASH_MOVE_FAILED hardening.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const { MockImapFlow, calls, behavior } = createImapMock({
  mailboxes: createMailboxes(),
  messages: createMessages(),
  searchUids: [101, 102, 103],
  moveError: 'BAD MOVE not supported on this server',
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('email_move_messages — copy fallback verification', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    behavior.copyError = undefined;
    behavior.copyPartialUidMap = false;
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

  it('falls back to COPY + expunge-source when the copy is verified complete', async () => {
    await setupClient();
    const flagsBefore = calls.messageFlagsAdd;
    const deleteBefore = calls.messageDelete;

    const result = await testClient.callTool('email_move_messages', {
      uids: [101, 102],
      mailbox: 'INBOX',
      destination: 'Archive',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.moved).toBe(2);
    // MOVE failed, so the fallback ran: copy, then \\Deleted + expunge.
    expect(calls.messageCopy).toBeGreaterThan(0);
    expect(calls.messageFlagsAdd).toBe(flagsBefore + 1);
    expect(calls.messageDelete).toBe(deleteBefore + 1);
  });

  it('aborts without expunging when the copy result is truthy but incomplete', async () => {
    await setupClient();
    behavior.copyPartialUidMap = true;
    const flagsBefore = calls.messageFlagsAdd;
    const deleteBefore = calls.messageDelete;

    const result = await testClient.callTool('email_move_messages', {
      uids: [101, 102],
      mailbox: 'INBOX',
      destination: 'Archive',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('MOVE_COPY_UNVERIFIED');
    expect(json.error as string).toContain('nothing was expunged');
    // The permanent path must NOT have run: no \Deleted flag, no expunge.
    expect(calls.messageFlagsAdd).toBe(flagsBefore);
    expect(calls.messageDelete).toBe(deleteBefore);
  });

  it('aborts without expunging when the copy itself fails', async () => {
    await setupClient();
    behavior.copyError = 'NO Quota exceeded';
    const flagsBefore = calls.messageFlagsAdd;
    const deleteBefore = calls.messageDelete;

    const result = await testClient.callTool('email_move_messages', {
      uids: [101],
      mailbox: 'INBOX',
      destination: 'Archive',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('MOVE_COPY_UNVERIFIED');
    expect(calls.messageFlagsAdd).toBe(flagsBefore);
    expect(calls.messageDelete).toBe(deleteBefore);
  });

  it('is annotated destructiveHint: true (fallback expunges the source)', async () => {
    await setupClient();

    const tools = await testClient.client.listTools();
    const entry = tools.tools.find((t) => t.name === 'email_move_messages');
    expect(entry, 'email_move_messages must be registered').toBeDefined();
    expect(entry!.annotations?.destructiveHint).toBe(true);
  });
});
