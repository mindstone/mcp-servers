/**
 * VAL-EMAIL-113 / VAL-EMAIL-114 — `email_get_message` htmlBody presence is
 * driven by the upstream MIME structure, not by the truthiness of the decoded
 * HTML body string. In particular:
 *
 *   1. text/html part present, non-empty body  →  htmlBody present and wrapped.
 *   2. text/html part present, empty body      →  htmlBody present and wrapped
 *      with empty inner content
 *      (`<untrusted-content source="external-email"></untrusted-content>`).
 *   3. No text/html part (text-only message)  →  htmlBody field absent from
 *      the response.
 *
 * Pre-fix behaviour: the wrapping site at `connectors/email-imap/src/tools/messages.ts`
 * uses `htmlBody ? { htmlBody: wrapUntrusted(htmlBody) } : {}` — an empty
 * string is falsy, so the field is dropped even though the source MIME has a
 * `text/html` part. This file pins the post-fix invariant.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock, type MockMessageData } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const fixtureMessages: MockMessageData[] = [
  // 301: multipart/alternative with non-empty text/html part.
  {
    uid: 301,
    envelope: {
      subject: 'Has HTML',
      from: [{ name: 'Sender', address: 'sender@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: new Date('2026-02-01T10:00:00Z'),
      messageId: '<has-html-301@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/html', part: '2' },
      ],
    },
    bodyByPart: {
      '1': 'plain text',
      '2': 'hi',
    },
  },
  // 302: multipart/alternative whose text/html part has an EMPTY body.
  {
    uid: 302,
    envelope: {
      subject: 'Empty HTML part',
      from: [{ name: 'Sender', address: 'sender@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: new Date('2026-02-02T10:00:00Z'),
      messageId: '<empty-html-302@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/html', part: '2' },
      ],
    },
    bodyByPart: {
      '1': 'plain text',
      '2': '',
    },
  },
  // 303: text-only message (NO text/html part).
  {
    uid: 303,
    envelope: {
      subject: 'Text only',
      from: [{ name: 'Sender', address: 'sender@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: new Date('2026-02-03T10:00:00Z'),
      messageId: '<text-only-303@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: {
      type: 'text/plain',
      part: '1',
    },
    bodyByPart: {
      '1': 'plain text only',
    },
  },
];

const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: fixtureMessages,
  searchUids: fixtureMessages.map((m) => m.uid),
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('email_get_message — htmlBody presence driven by MIME (VAL-EMAIL-113/114)', () => {
  let testClient: Awaited<
    ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>
  >;

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

  async function getMessage(uid: number): Promise<Record<string, unknown>> {
    await setupClient();
    const result = await testClient.callTool('email_get_message', {
      mailbox: 'INBOX',
      uid,
    });
    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    return json.message as Record<string, unknown>;
  }

  type Case = {
    label: string;
    uid: number;
    expectHtmlKey: boolean;
    expectedHtmlBody?: string;
  };

  const cases: Case[] = [
    {
      label: 'text/html part present, non-empty body → htmlBody wrapped',
      uid: 301,
      expectHtmlKey: true,
      expectedHtmlBody:
        '<untrusted-content source="external-email">hi</untrusted-content>',
    },
    {
      label:
        'VAL-EMAIL-113 — text/html part present, empty body → htmlBody wrapped (empty inner)',
      uid: 302,
      expectHtmlKey: true,
      expectedHtmlBody:
        '<untrusted-content source="external-email"></untrusted-content>',
    },
    {
      label:
        'VAL-EMAIL-114 — no text/html part → htmlBody field absent from response',
      uid: 303,
      expectHtmlKey: false,
    },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const message = await getMessage(c.uid);
      if (c.expectHtmlKey) {
        expect(Object.prototype.hasOwnProperty.call(message, 'htmlBody')).toBe(
          true,
        );
        expect(message.htmlBody).toBe(c.expectedHtmlBody);
      } else {
        expect(Object.prototype.hasOwnProperty.call(message, 'htmlBody')).toBe(
          false,
        );
      }
    });
  }

  it('VAL-EMAIL-113/114 — textBody behaviour unchanged across the three cases', async () => {
    const m301 = await getMessage(301);
    expect(m301.textBody).toBe(
      '<untrusted-content source="external-email">plain text</untrusted-content>',
    );

    const m302 = await getMessage(302);
    expect(m302.textBody).toBe(
      '<untrusted-content source="external-email">plain text</untrusted-content>',
    );

    const m303 = await getMessage(303);
    expect(m303.textBody).toBe(
      '<untrusted-content source="external-email">plain text only</untrusted-content>',
    );
  });
});
