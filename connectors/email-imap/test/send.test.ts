import { readFile, readdir } from 'node:fs/promises';
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

    it('VAL-EMAIL-003 — recipient cap default is 25 (combined to+cc+bcc, at limit succeeds)', async () => {
      // No EMAIL_IMAP_MAX_RECIPIENTS env → default 25 is used.
      await setupClient();
      const toList = Array.from({ length: 10 }, (_, i) => `to${i}@example.com`);
      const ccList = Array.from({ length: 10 }, (_, i) => `cc${i}@example.com`);
      const bccList = Array.from({ length: 5 }, (_, i) => `bcc${i}@example.com`);
      const result = await testClient.callTool('email_send', {
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: 'cap test',
        text: 'body',
      });
      expect(result.isError).toBeFalsy();
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
    });

    it('VAL-EMAIL-004 — recipient cap enforced (positive — exactly at limit succeeds)', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '3' });
      const result = await testClient.callTool('email_send', {
        to: ['a@example.com', 'b@example.com'],
        cc: ['c@example.com'],
        subject: 'at-cap',
        text: 'body',
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
    });

    it('VAL-EMAIL-005 — recipient cap enforced (negative — over limit returns RECIPIENT_LIMIT_EXCEEDED)', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '2' });
      const result = await testClient.callTool('email_send', {
        to: ['a@example.com', 'b@example.com'],
        cc: ['c@example.com'],
        subject: 'over-cap',
        text: 'body',
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('RECIPIENT_LIMIT_EXCEEDED');
      expect(json.limit).toBe(2);
      expect(json.observed).toBe(3);
      expect(typeof json.error).toBe('string');
      expect(mockTransport.sendMail).not.toHaveBeenCalled();
    });

    it('VAL-EMAIL-006 — recipient cap counts To+CC+BCC combined (1+1+1 over cap=2 rejected)', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '2' });
      const result = await testClient.callTool('email_send', {
        to: ['a@example.com'],
        cc: ['b@example.com'],
        bcc: ['c@example.com'],
        subject: 'combined',
        text: 'body',
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('RECIPIENT_LIMIT_EXCEEDED');
      expect(json.observed).toBe(3);
      expect(mockTransport.sendMail).not.toHaveBeenCalled();
    });

    it('VAL-EMAIL-007 — rate-limit defaults (50/hour, 3_600_000ms) baked into source', async () => {
      const dir = join(__dirname, '..', 'src', 'tools');
      const files = await readdir(dir);
      const tsFiles = files.filter((f) => f.endsWith('.ts'));
      const sources = await Promise.all(
        tsFiles.map((f) => readFile(join(dir, f), 'utf8')),
      );
      const concat = sources.join('\n');
      expect(concat).toMatch(/EMAIL_IMAP_RATE_LIMIT_PER_HOUR/);
      expect(concat).toMatch(/EMAIL_IMAP_RATE_LIMIT_WINDOW_MS/);
      expect(concat).toMatch(/EMAIL_IMAP_MAX_RECIPIENTS/);
      // Defaults must be literal in source.
      expect(concat).toMatch(/\b50\b/);
      expect(concat).toMatch(/3_?600_?000/);
      expect(concat).toMatch(/\b25\b/);
    });

    it('VAL-EMAIL-008 — rate cap under cap → all sequential sends succeed', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_RATE_LIMIT_PER_HOUR: '3' });
      for (let i = 0; i < 3; i += 1) {
        const r = await testClient.callTool('email_send', {
          to: 'r@example.com',
          subject: `s${i}`,
          text: 'body',
        });
        const json = r.json as Record<string, unknown>;
        expect(json.ok).toBe(true);
      }
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(3);
    });

    it('VAL-EMAIL-009 — rate cap over cap → RATE_LIMIT_EXCEEDED with resetAt and retryAfterMs', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_RATE_LIMIT_PER_HOUR: '2' });
      const r1 = await testClient.callTool('email_send', {
        to: 'a@example.com',
        subject: 's1',
        text: 'body',
      });
      const r2 = await testClient.callTool('email_send', {
        to: 'a@example.com',
        subject: 's2',
        text: 'body',
      });
      const r3 = await testClient.callTool('email_send', {
        to: 'a@example.com',
        subject: 's3',
        text: 'body',
      });
      expect((r1.json as Record<string, unknown>).ok).toBe(true);
      expect((r2.json as Record<string, unknown>).ok).toBe(true);
      const j3 = r3.json as Record<string, unknown>;
      expect(j3.ok).toBe(false);
      expect(j3.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(j3.limit).toBe(2);
      // resetAt is a parseable ISO-8601 string and retryAfterMs > 0.
      expect(typeof j3.resetAt).toBe('string');
      expect(Number.isFinite(Date.parse(j3.resetAt as string))).toBe(true);
      expect(typeof j3.retryAfterMs).toBe('number');
      expect(j3.retryAfterMs as number).toBeGreaterThan(0);
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(2);
    });

    it('VAL-EMAIL-020 — rate window is configurable; window elapse re-allows sends', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(0));
        await setupClientWithEnv({
          EMAIL_IMAP_RATE_LIMIT_PER_HOUR: '1',
          EMAIL_IMAP_RATE_LIMIT_WINDOW_MS: '50',
        });
        const r1 = await testClient.callTool('email_send', {
          to: 'a@example.com',
          subject: 's1',
          text: 'body',
        });
        expect((r1.json as Record<string, unknown>).ok).toBe(true);
        const r2 = await testClient.callTool('email_send', {
          to: 'a@example.com',
          subject: 's2',
          text: 'body',
        });
        const j2 = r2.json as Record<string, unknown>;
        expect(j2.ok).toBe(false);
        expect(j2.code).toBe('RATE_LIMIT_EXCEEDED');
        // Advance past the window.
        vi.setSystemTime(new Date(60));
        vi.advanceTimersByTime(60);
        const r3 = await testClient.callTool('email_send', {
          to: 'a@example.com',
          subject: 's3',
          text: 'body',
        });
        const j3 = r3.json as Record<string, unknown>;
        expect(j3.ok).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('VAL-EMAIL-024 — cap counts comma-separated addresses inside string to/cc/bcc fields', async () => {
      await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '2' });
      const result = await testClient.callTool('email_send', {
        to: 'a@x.com, b@x.com, c@x.com',
        subject: 'comma-string-over-cap',
        text: 'body',
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('RECIPIENT_LIMIT_EXCEEDED');
      expect(json.limit).toBe(2);
      expect(json.observed).toBe(3);
      expect(typeof json.error).toBe('string');
      expect(mockTransport.sendMail).not.toHaveBeenCalled();
    });

    describe('VAL-EMAIL-025 — recipient counting is shape-invariant', () => {
      const shapes: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: 'string with commas',
          args: { to: 'a@x.com, b@x.com' },
        },
        {
          name: 'array of singles',
          args: { to: ['a@x.com', 'b@x.com'] },
        },
        {
          name: 'array of comma-strings',
          args: { to: ['a@x.com, b@x.com'] },
        },
        {
          name: 'to + cc split',
          args: { to: 'a@x.com', cc: 'b@x.com' },
        },
      ];

      for (const shape of shapes) {
        it(`cap=2 allows shape "${shape.name}"`, async () => {
          await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '2' });
          const result = await testClient.callTool('email_send', {
            ...shape.args,
            subject: `shape-pass-${shape.name}`,
            text: 'body',
          });
          const json = result.json as Record<string, unknown>;
          expect(json.ok).toBe(true);
          expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
        });
      }

      for (const shape of shapes) {
        it(`cap=1 rejects shape "${shape.name}" with RECIPIENT_LIMIT_EXCEEDED`, async () => {
          await setupClientWithEnv({ EMAIL_IMAP_MAX_RECIPIENTS: '1' });
          const result = await testClient.callTool('email_send', {
            ...shape.args,
            subject: `shape-fail-${shape.name}`,
            text: 'body',
          });
          const json = result.json as Record<string, unknown>;
          expect(json.ok).toBe(false);
          expect(json.code).toBe('RECIPIENT_LIMIT_EXCEEDED');
          expect(json.limit).toBe(1);
          expect(json.observed).toBe(2);
          expect(mockTransport.sendMail).not.toHaveBeenCalled();
        });
      }
    });

    it('VAL-EMAIL-023 — vanilla single-recipient send still works under default caps', async () => {
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
