import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import type { SentMessageInfo } from 'nodemailer/lib/stream-transport';
import { createImapMock } from './helpers/imap-mock.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const { MockImapFlow, constructorCalls } = createImapMock();

vi.mock('imapflow', () => ({ ImapFlow: MockImapFlow }));

const sender = 'sender@example.com';
const attachmentBytes = Buffer.from([0, 1, 2, 13, 10, 255]);
const textLines = ['Plain text body.', 'Second line.'];
const messageFields = {
  subject: 'Parser compatibility',
  // CRLF input checks that draft transport adds no newline conversion, not that arbitrary caller bodies are normalized.
  text: textLines.join('\r\n'),
  html: '<p>HTML body.</p>',
  reply_to_message_id: '<original@example.com>',
};

const recipientCases = [
  {
    name: 'ordinary RFC addresses',
    to: [
      'Jane Doe <jane@example.com>',
      '"Doe, Pat" <pat@example.com>',
      'Quoted <"local part"@example.com>',
      'International <marta@bücher.example>',
    ],
    envelopeTo: [
      'jane@example.com',
      'pat@example.com',
      '"local part"@example.com',
      'marta@xn--bcher-kva.example',
    ],
    headerTo:
      'Jane Doe <jane@example.com>, "Doe, Pat" <pat@example.com>, ' +
      'Quoted <"local part"@example.com>, International <marta@xn--bcher-kva.example>',
  },
  {
    // GHSA-85x2-q946-cp5h: a quoted '>' must not terminate the angle-addr.
    // mime-node replaces angle characters with spaces, retaining the intended domain.
    name: 'quoted angle-addr (GHSA-85x2-q946-cp5h)',
    to: 'Quoted <"local@decoy.example>"@intended.example>',
    envelopeTo: ['"local@decoy.example "@intended.example'],
    headerTo: 'Quoted <"local@decoy.example "@intended.example>',
  },
];

function createBufferedTransport() {
  return nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
}

function messageText(raw: unknown): string {
  expect(Buffer.isBuffer(raw), 'Nodemailer must return a buffered RFC822 message').toBe(true);
  if (!Buffer.isBuffer(raw)) {
    throw new Error('Expected a buffered RFC822 message');
  }
  return raw.toString('utf8').replace(/\r\n/g, '\n');
}

function expectDraftLineEndings(raw: unknown): void {
  expect(Buffer.isBuffer(raw), 'IMAP APPEND must receive a Buffer').toBe(true);
  if (!Buffer.isBuffer(raw)) {
    throw new Error('Expected a buffered draft message');
  }
  expect(
    raw.findIndex((byte, index) => byte === 0x0a && raw[index - 1] !== 0x0d),
    'IMAP APPEND must not contain bare LF bytes',
  ).toBe(-1);
  expect(raw.includes('\r\n\r\n'), 'Draft headers must end with a CRLF separator').toBe(true);
}

function header(message: string, name: string): string | undefined {
  return message
    .split('\n\n')[0]!
    .replace(/\n[ \t]+/g, ' ')
    .split('\n')
    .find((line) => line.startsWith(`${name}: `))
    ?.slice(name.length + 2);
}

function expectGeneratedMessage(raw: unknown, headerTo: string): string {
  const message = messageText(raw);
  expect(header(message, 'From')).toBe(sender);
  expect(header(message, 'To')).toBe(headerTo);
  expect(header(message, 'Subject')).toBe(messageFields.subject);
  expect(header(message, 'In-Reply-To')).toBe(messageFields.reply_to_message_id);
  expect(header(message, 'References')).toBe(messageFields.reply_to_message_id);
  expect(message).toContain('Content-Type: multipart/mixed;');
  expect(message).toContain('Content-Type: multipart/alternative;');
  expect(message).toContain('Content-Type: text/plain; charset=utf-8');
  expect(message).toContain(textLines.join('\n'));
  expect(message).toContain('Content-Type: text/html; charset=utf-8');
  expect(message).toContain(messageFields.html);
  expect(message).toContain('Content-Disposition: attachment; filename=payload.bin');
  expect(message).toContain('Content-Transfer-Encoding: base64');
  expect(message).toContain(`\n\n${attachmentBytes.toString('base64')}\n`);
  return message;
}

describe('real Nodemailer compatibility', () => {
  let testClient: McpTestClient | undefined;
  let streamTransport: ReturnType<typeof createBufferedTransport> | undefined;
  let workspace: string | undefined;
  let attachmentPath: string;
  let sentMessages: SentMessageInfo[];

  beforeEach(async () => {
    constructorCalls.length = 0;
    sentMessages = [];
    workspace = await mkdtemp(join(tmpdir(), 'email-imap-nodemailer-'));
    attachmentPath = join(workspace, 'payload.bin');
    await writeFile(attachmentPath, attachmentBytes);

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: sender,
        EMAIL_IMAP_PASSWORD: 'synthetic-password',
        EMAIL_IMAP_PROVIDER: 'custom',
        EMAIL_IMAP_IMAP_HOST: 'imap.example.com',
        EMAIL_IMAP_IMAP_PORT: '993',
        EMAIL_IMAP_SMTP_HOST: 'smtp.example.com',
        EMAIL_IMAP_SMTP_PORT: '587',
        EMAIL_IMAP_MAX_RECIPIENTS: '25',
        EMAIL_IMAP_RATE_LIMIT_PER_HOUR: '50',
        EMAIL_IMAP_RATE_LIMIT_WINDOW_MS: '3600000',
        MCP_WORKSPACE_PATH: workspace,
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
      },
    });

    // Replace only the SMTP boundary; draft generation uses Nodemailer directly.
    const smtpClient = await import('../src/smtp-client.js');
    const transport = createBufferedTransport();
    streamTransport = transport;
    vi.spyOn(smtpClient, 'getTransport').mockResolvedValue({
      async sendMail(options) {
        const info = await transport.sendMail(options);
        sentMessages.push(info);
        return info;
      },
      close: () => transport.close(),
    });

    const configured = await testClient.callTool('configure_email_imap', {
      email: sender,
      password: 'synthetic-password',
      provider: 'custom',
    });
    expect(configured.isError).toBeFalsy();
    expect(configured.json).toMatchObject({ ok: true });
  });

  afterEach(async () => {
    await testClient?.close();
    testClient = undefined;
    const { cleanupClients } = await import('../src/tools/index.js');
    await cleanupClients();
    streamTransport?.close();
    streamTransport = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
  });

  function fields() {
    return {
      ...messageFields,
      attachments: [{ path: attachmentPath, filename: 'payload.bin' }],
    };
  }

  describe.each(recipientCases)('$name', ({ to, envelopeTo, headerTo }) => {
    it('email_send generates the expected envelope and MIME content', async () => {
      const result = await testClient!.callTool('email_send', {
        ...fields(),
        to,
        cc: 'Copy <copy@example.com>',
        bcc: ['blind@example.com'],
      });
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ ok: true });
      expect(sentMessages).toHaveLength(1);
      const info = sentMessages[0]!;
      expect(info.envelope).toEqual({
        from: sender,
        to: [...envelopeTo, 'copy@example.com', 'blind@example.com'],
      });
      const message = expectGeneratedMessage(info.message, headerTo);
      expect(header(message, 'Cc')).toBe('Copy <copy@example.com>');
      expect(result.json).toMatchObject({ messageId: header(message, 'Message-ID') });
    });

    it('email_save_draft appends the real buffered message with draft flags', async () => {
      const append = vi.spyOn(MockImapFlow.prototype, 'append');
      const result = await testClient!.callTool('email_save_draft', { ...fields(), to });
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ ok: true, uid: 999 });
      expect(append).toHaveBeenCalledExactlyOnceWith('Drafts', expect.any(Buffer), [
        '\\Draft',
        '\\Seen',
      ]);
      expectDraftLineEndings(append.mock.calls[0]![1]);
      const message = expectGeneratedMessage(append.mock.calls[0]![1], headerTo);
      expect(result.json).toMatchObject({ messageId: header(message, 'Message-ID') });
      expect(sentMessages).toHaveLength(0);
    });

    it('email_update_draft saves the real replacement before deleting the old draft', async () => {
      const events: string[] = [];
      const append = vi.spyOn(MockImapFlow.prototype, 'append').mockImplementation(async () => {
        events.push('append');
        return { uid: 999 };
      });
      const markDeleted = vi.spyOn(MockImapFlow.prototype, 'messageFlagsAdd')
        .mockImplementation(async () => {
          events.push('mark-deleted');
          return true;
        });
      const deleteDraft = vi.spyOn(MockImapFlow.prototype, 'messageDelete')
        .mockImplementation(async () => {
          events.push('delete');
          return true;
        });

      const result = await testClient!.callTool('email_update_draft', { ...fields(), to, uid: 101 });
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ ok: true, uid: 999, replacedUid: 101 });
      expect(events).toEqual(['append', 'mark-deleted', 'delete']);
      expect(append).toHaveBeenCalledExactlyOnceWith('Drafts', expect.any(Buffer), [
        '\\Draft',
        '\\Seen',
      ]);
      expect(markDeleted).toHaveBeenCalledExactlyOnceWith([101], ['\\Deleted'], { uid: true });
      expect(deleteDraft).toHaveBeenCalledExactlyOnceWith([101], { uid: true });
      expectDraftLineEndings(append.mock.calls[0]![1]);
      const message = expectGeneratedMessage(append.mock.calls[0]![1], headerTo);
      expect(result.json).toMatchObject({ messageId: header(message, 'Message-ID') });
    });
  });

  it('leaves the old draft intact when appending the real replacement fails', async () => {
    const append = vi.spyOn(MockImapFlow.prototype, 'append')
      .mockRejectedValueOnce(new Error('Synthetic append failure'));
    const markDeleted = vi.spyOn(MockImapFlow.prototype, 'messageFlagsAdd');
    const deleteDraft = vi.spyOn(MockImapFlow.prototype, 'messageDelete');

    const result = await testClient!.callTool('email_update_draft', {
      ...fields(),
      to: 'Jane Doe <jane@example.com>',
      uid: 101,
    });
    expect(result.isError).toBe(true);
    expectDraftLineEndings(append.mock.calls[0]![1]);
    expectGeneratedMessage(append.mock.calls[0]![1], 'Jane Doe <jane@example.com>');
    expect(markDeleted).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('drops omitted content and attachments when replacing a draft', async () => {
    const append = vi.spyOn(MockImapFlow.prototype, 'append');
    const saved = await testClient!.callTool('email_save_draft', {
      ...fields(),
      to: 'jane@example.com',
    });
    expect(saved.isError).toBeFalsy();
    expectDraftLineEndings(append.mock.calls[0]![1]);
    expectGeneratedMessage(append.mock.calls[0]![1], 'jane@example.com');

    const updated = await testClient!.callTool('email_update_draft', {
      uid: 999,
      subject: 'Replacement only',
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.json).toMatchObject({ ok: true, replacedUid: 999 });
    expect(append).toHaveBeenCalledTimes(2);
    expectDraftLineEndings(append.mock.calls[1]![1]);
    const replacement = messageText(append.mock.calls[1]![1]);
    expect(header(replacement, 'Subject')).toBe('Replacement only');
    expect(header(replacement, 'To')).toBeUndefined();
    for (const line of textLines) {
      expect(replacement).not.toContain(line);
    }
    expect(replacement).not.toContain(messageFields.html);
    expect(replacement).not.toContain('payload.bin');
    expect(replacement).not.toContain(attachmentBytes.toString('base64'));
  });

  it('does not configure the ImapFlow proxy that could reach its nested Nodemailer copy', async () => {
    const { getConnection } = await import('../src/imap-client.js');
    await getConnection();
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]![0]).toMatchObject({ host: 'imap.example.com', port: 993 });
    expect(constructorCalls[0]![0]).not.toHaveProperty('proxy');
  });
});
