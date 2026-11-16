import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';
import { wrapUntrusted } from '../src/untrusted-content.js';

// The connector returns message IDs and addresses inside untrusted-content
// envelopes, and callers pass them back as they are. Sent on unchanged, an
// enveloped Message-ID lands in In-Reply-To and References (the reply does not
// thread) and an enveloped address becomes a garbage recipient.

const { MockImapFlow } = createImapMock({ mailboxes: createMailboxes() });
const { createTransport: mockCreateTransport, mockTransport, streamTransport } = createSmtpMock();

vi.mock('imapflow', () => ({ ImapFlow: MockImapFlow }));
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

const wrap = (s: string) => wrapUntrusted(s, 'external-email') as string;

describe('enveloped values passed back to send and draft tools', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  beforeEach(async () => {
    mockTransport.sendMail.mockClear();
    streamTransport.sendMail.mockClear();
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
  });

  afterEach(async () => {
    await testClient.close();
    vi.unstubAllEnvs();
  });

  it('email_send threads the reply and addresses the real recipients', async () => {
    const result = await testClient.callTool('email_send', {
      to: wrap('original-sender@example.com'),
      cc: [wrap('Ann Example <ann@example.com>')],
      subject: wrap('Re: Original Subject'),
      text: 'Reply body',
      reply_to_message_id: wrap('<original-123@example.com>'),
    });
    expect(result.isError).toBeFalsy();

    const sent = mockTransport.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.to).toBe('original-sender@example.com');
    expect(sent.cc).toEqual(['Ann Example <ann@example.com>']);
    expect(sent.subject).toBe('Re: Original Subject');
    expect(sent.inReplyTo).toBe('<original-123@example.com>');
    expect(sent.references).toBe('<original-123@example.com>');
  });

  it('email_save_draft threads the draft reply', async () => {
    const result = await testClient.callTool('email_save_draft', {
      to: wrap('original-sender@example.com'),
      subject: 'Re: Original Subject',
      text: 'Draft reply',
      reply_to_message_id: wrap('<original-123@example.com>'),
    });
    expect(result.isError).toBeFalsy();

    const draft = streamTransport.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(draft.to).toBe('original-sender@example.com');
    expect(draft.inReplyTo).toBe('<original-123@example.com>');
    expect(draft.references).toBe('<original-123@example.com>');
  });

  it('leaves a body that only quotes enveloped text as written', async () => {
    const body = `Quoting: ${wrap('their words')} end`;
    const result = await testClient.callTool('email_send', {
      to: 'someone@example.com',
      subject: 'Quote',
      text: body,
    });
    expect(result.isError).toBeFalsy();

    const sent = mockTransport.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.text).toBe(body);
  });
});
