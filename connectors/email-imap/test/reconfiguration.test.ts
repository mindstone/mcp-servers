/**
 * Reconfiguring the account in the same process (no module reset between
 * accounts): changed credentials replace the IMAP connection and SMTP
 * transport and clear the per-mailbox UID-validity map; equal credentials
 * keep the existing clients. See the README's reset-on-reconfigure checklist.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface ImapInstance {
  user: string;
  loggedOut: boolean;
}

const imapInstances: ImapInstance[] = [];
// Each account sees a different UID validity for the same mailbox, as two
// different servers (or a recreated mailbox) would.
const uidValidityByUser: Record<string, bigint> = {
  'alice@icloud.com': BigInt(100),
  'bob@icloud.com': BigInt(200),
};

class MockImapFlow {
  usable = true;
  mailbox: { path: string; uidValidity: bigint } | null = null;
  private readonly record: ImapInstance;

  constructor(options: { auth: { user: string } }) {
    this.record = { user: options.auth.user, loggedOut: false };
    imapInstances.push(this.record);
  }

  async connect() {}

  async noop() {}

  async logout() {
    this.usable = false;
    this.record.loggedOut = true;
  }

  close() {
    this.usable = false;
  }

  on(_event: string, _handler: (...args: unknown[]) => void) {}

  async status(_mailbox: string, _opts?: unknown) {
    return { messages: 0, unseen: 0 };
  }

  async getMailboxLock(path: string) {
    this.mailbox = { path, uidValidity: uidValidityByUser[this.record.user]! };
    return { release: vi.fn() };
  }

  async search(_criteria: unknown, _opts?: unknown) {
    return [];
  }
}

interface SmtpInstance {
  user: string;
  close: ReturnType<typeof vi.fn>;
}

const smtpInstances: SmtpInstance[] = [];

const createTransport = vi.fn((config: { auth: { user: string } }) => {
  const instance: SmtpInstance = { user: config.auth.user, close: vi.fn() };
  smtpInstances.push(instance);
  return {
    sendMail: vi.fn(async () => ({ messageId: '<sent@example.com>' })),
    verify: vi.fn(async () => true),
    close: instance.close,
  };
});

vi.mock('imapflow', () => ({ ImapFlow: MockImapFlow }));

vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

describe('reconfiguration in the same process', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    imapInstances.length = 0;
    smtpInstances.length = 0;
    vi.unstubAllEnvs();
  });

  async function startServer() {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');
    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
      },
    });
  }

  async function configure(email: string, password: string) {
    const result = await testClient.callTool('configure_email_imap', {
      email,
      password,
      provider: 'icloud',
    });
    expect(result.isError).toBeFalsy();
  }

  async function expectOk(call: Promise<{ isError?: boolean; content: unknown }>) {
    const result = await call;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  }

  // Opens the mailbox under a lock, which records its UID validity.
  function openArchive() {
    return expectOk(
      testClient.callTool('email_get_mailbox_status', { mailbox: 'Archive', includeLatest: true }),
    );
  }

  function send() {
    return expectOk(
      testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'Hello',
        text: 'Body',
      }),
    );
  }

  it('replaces account clients and clears mailbox UID validity on changed configuration', async () => {
    await startServer();

    await configure('alice@icloud.com', 'pw-a');
    await openArchive();
    await send();
    expect(imapInstances.map((i) => i.user)).toEqual(['alice@icloud.com']);
    expect(smtpInstances.map((i) => i.user)).toEqual(['alice@icloud.com']);

    await configure('bob@icloud.com', 'pw-b');

    // The old account's connection and transport are closed.
    expect(imapInstances[0]!.loggedOut).toBe(true);
    expect(smtpInstances[0]!.close).toHaveBeenCalledTimes(1);

    // The same mailbox under the new account's different UID validity opens
    // cleanly: the old account's entry was cleared, not compared against.
    await openArchive();
    await send();

    expect(imapInstances.map((i) => i.user)).toEqual(['alice@icloud.com', 'bob@icloud.com']);
    expect(smtpInstances.map((i) => i.user)).toEqual(['alice@icloud.com', 'bob@icloud.com']);
    expect(imapInstances[1]!.loggedOut).toBe(false);
  });

  it('keeps the existing clients when the configuration is unchanged', async () => {
    await startServer();

    await configure('alice@icloud.com', 'pw-a');
    await openArchive();
    await send();

    await configure('alice@icloud.com', 'pw-a');
    await openArchive();
    await send();

    expect(imapInstances).toHaveLength(1);
    expect(imapInstances[0]!.loggedOut).toBe(false);
    expect(smtpInstances).toHaveLength(1);
    expect(smtpInstances[0]!.close).not.toHaveBeenCalled();
  });
});
