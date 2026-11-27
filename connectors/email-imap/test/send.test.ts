import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const { MockImapFlow } = createImapMock({ mailboxes: createMailboxes() });
const { createTransport: mockCreateTransport, mockTransport, streamTransport } = createSmtpMock();

const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Send/draft tools', () => {
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

  describe('email_send', () => {
    it('sends an email and returns messageId', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'Test subject',
        text: 'Hello, this is a test email.',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.messageId).toBeDefined();
      expect(typeof json.messageId).toBe('string');
    });

    it('sends to multiple recipients', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: ['a@example.com', 'b@example.com'],
        subject: 'Multi-recipient test',
        text: 'Hello all',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('sends with cc and bcc', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'CC/BCC test',
        text: 'Body',
        cc: 'cc@example.com',
        bcc: ['bcc1@example.com', 'bcc2@example.com'],
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('sends a reply with reply_to_message_id', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        to: 'original-sender@example.com',
        subject: 'Re: Original Subject',
        text: 'Reply body',
        reply_to_message_id: '<original-123@example.com>',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });

    it('validates to is required', async () => {
      await setupClient();

      const result = await testClient.callTool('email_send', {
        subject: 'No recipient',
        text: 'Body',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('email_send hardening (M2.5)', () => {
    beforeEach(() => {
      mockTransport.sendMail.mockClear();
    });

    async function setupClientWithEnv(extra: Record<string, string>) {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');
      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: 'test@icloud.com',
          EMAIL_IMAP_PASSWORD: 'test-pass',
          EMAIL_IMAP_PROVIDER: 'icloud',
          MCP_HOST_BRIDGE_STATE: '',
          ...extra,
        },
      });
      await testClient.callTool('configure_email_imap', {
        email: 'test@icloud.com',
        password: 'test-pass',
        provider: 'icloud',
      });
      return testClient;
    }

    it('VAL-EMAIL-001 — registers email_send with destructiveHint:true and openWorldHint:true', async () => {
      await setupClient();
      const tools = await testClient.client.listTools();
      const send = tools.tools.find((t) => t.name === 'email_send');
      expect(send).toBeDefined();
      expect(send!.annotations?.destructiveHint).toBe(true);
      expect(send!.annotations?.openWorldHint).toBe(true);
      expect(send!.annotations?.readOnlyHint).toBe(false);
    });

    it('VAL-EMAIL-002 — destructiveHint:true present in send.ts source', async () => {
      const src = await readFile(join(__dirname, '..', 'src', 'tools', 'send.ts'), 'utf8');
      expect(/destructiveHint:\s*true/.test(src)).toBe(true);
    });

    it('VAL-EMAIL-002a — no destructiveHint:false inside the email_send registration block', async () => {
      const src = await readFile(join(__dirname, '..', 'src', 'tools', 'send.ts'), 'utf8');
      const startIdx = src.indexOf("'email_send'");
      expect(startIdx).toBeGreaterThan(-1);
      // Slice from the email_send identifier to the next registerTool call.
      const after = src.slice(startIdx);
      const nextRegisterIdx = after.indexOf('registerTool(', 1);
      const block = nextRegisterIdx > -1 ? after.slice(0, nextRegisterIdx) : after;
      expect(/destructiveHint:\s*false/.test(block)).toBe(false);
    });

    it('sends 26 combined To+CC+BCC recipients in one SMTP call (no connector recipient cap)', async () => {
      await setupClient();
      const toList = Array.from({ length: 10 }, (_, i) => `to${i}@example.com`);
      const ccList = Array.from({ length: 10 }, (_, i) => `cc${i}@example.com`);
      const bccList = Array.from({ length: 6 }, (_, i) => `bcc${i}@example.com`);
      const result = await testClient.callTool('email_send', {
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: 'twenty-six recipients',
        text: 'body',
      });
      expect(result.isError).toBeFalsy();
      expect((result.json as Record<string, unknown>).ok).toBe(true);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
      expect(mockTransport.sendMail.mock.calls[0]![0]).toMatchObject({
        to: toList,
        cc: ccList,
        bcc: bccList,
      });
    });

    it('sends 51 sequential emails, each reaching SMTP (no connector send-rate cap)', async () => {
      await setupClient();
      for (let i = 0; i < 51; i += 1) {
        const r = await testClient.callTool('email_send', {
          to: 'r@example.com',
          subject: `s${i}`,
          text: 'body',
        });
        expect((r.json as Record<string, unknown>).ok).toBe(true);
      }
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(51);
    });

    it('ignores the old cap env vars, so a tiny value cannot bring a cap back', async () => {
      await setupClientWithEnv({
        EMAIL_IMAP_MAX_RECIPIENTS: '1',
        EMAIL_IMAP_RATE_LIMIT_PER_HOUR: '1',
        EMAIL_IMAP_RATE_LIMIT_WINDOW_MS: '3600000',
      });
      for (let i = 0; i < 3; i += 1) {
        const r = await testClient.callTool('email_send', {
          to: ['a@example.com', 'b@example.com'],
          cc: 'c@example.com',
          subject: `old-env-${i}`,
          text: 'body',
        });
        expect((r.json as Record<string, unknown>).ok).toBe(true);
      }
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(3);
    });

    it('passes a provider "too many recipients" SMTP rejection through as an error result', async () => {
      await setupClient();
      const providerMessage = '452 4.5.3 Too many recipients';
      mockTransport.sendMail.mockRejectedValueOnce(
        Object.assign(new Error(providerMessage), { responseCode: 452 }),
      );
      const result = await testClient.callTool('email_send', {
        to: 'a@example.com',
        subject: 'provider refusal',
        text: 'body',
      });
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('INTERNAL_ERROR');
      expect(String(json.error)).toContain(providerMessage);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
    });

    it('VAL-EMAIL-023 — vanilla single-recipient send works', async () => {
      await setupClient();
      const result = await testClient.callTool('email_send', {
        to: 'recipient@example.com',
        subject: 'baseline',
        text: 'body',
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('email_save_draft', () => {
    it('saves a draft and returns messageId and mailbox', async () => {
      await setupClient();

      const result = await testClient.callTool('email_save_draft', {
        to: 'draft-recipient@example.com',
        subject: 'Draft subject',
        text: 'Draft body content',
      });
      expect(result.isError).toBeFalsy();

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.messageId).toBeDefined();
      expect(json.mailbox).toBeDefined();
    });

    it('requires at least subject or body', async () => {
      await setupClient();

      const result = await testClient.callTool('email_save_draft', {
        to: 'someone@example.com',
      });
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.error).toContain('subject or a text/html body');
    });

    it('is annotated destructiveHint: true (remote mailbox mutation)', async () => {
      await setupClient();

      const tools = await testClient.client.listTools();
      const entry = tools.tools.find((t) => t.name === 'email_save_draft');
      expect(entry, 'email_save_draft must be registered').toBeDefined();
      expect(entry!.annotations?.destructiveHint).toBe(true);
    });
  });
});
