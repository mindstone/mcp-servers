/**
 * email_search_messages — servers that reject the text SEARCH keys.
 *
 * Some IMAP servers answer `SEARCH FROM` / `SEARCH SUBJECT` with `BAD invalid
 * command or parameters` while `SEARCH ALL` / `SINCE` / `UNSEEN` work fine
 * (Alibaba Mail is one). imapflow reports that by RETURNING `false`, so the
 * connector used to report "no messages" for a search the server simply could
 * not run. It must instead list a date window the server CAN search and filter
 * those envelopes locally — and when even that is impossible, fail loudly.
 *
 * The scan cap lives in search-text-fallback-scan-cap.test.ts (it needs a
 * mailbox bigger than FALLBACK_MAX_SCANNED, and vi.mock is per-file).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createImapMock, type MockMessageData } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (days: number): Date => new Date(NOW - days * MS_PER_DAY);

/**
 * Fixture built so each filter has a discriminating answer:
 *  - 201 has "quarterly" in its subject but sits OUTSIDE the default window.
 *  - 203/204 have it in the subject only; 205 has it in the sender name only.
 *  - 202 and 205 are the only unread messages.
 */
const messages: MockMessageData[] = [
  {
    uid: 201,
    envelope: {
      subject: 'Old quarterly report',
      from: [{ name: 'Reports Bot', address: 'reports@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(200),
      messageId: '<old-201@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
  {
    uid: 202,
    envelope: {
      subject: 'Lunch plans',
      from: [{ name: 'Carol White', address: 'carol@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(40),
      messageId: '<lunch-202@example.com>',
    },
    flags: new Set(),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
  {
    uid: 203,
    envelope: {
      subject: 'Quarterly numbers, revised',
      from: [{ name: 'Dave Brown', address: 'dave@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(30),
      messageId: '<numbers-203@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
  {
    uid: 204,
    envelope: {
      subject: 'Re: QUARTERLY planning',
      from: [{ name: 'Erin Black', address: 'erin@partner.example' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(20),
      messageId: '<planning-204@example.com>',
    },
    flags: new Set(['\\Seen', '\\Flagged']),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
  {
    uid: 205,
    envelope: {
      subject: 'Weekly sync',
      from: [{ name: 'Quarterly Digest', address: 'digest@example.com' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(10),
      messageId: '<sync-205@example.com>',
    },
    flags: new Set(),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
  {
    uid: 206,
    envelope: {
      subject: 'Invoice 4417',
      from: [{ name: 'Zoe Green', address: 'zoe@vendor.example' }],
      to: [{ name: 'Test User', address: 'test@icloud.com' }],
      date: daysAgo(5),
      messageId: '<invoice-206@example.com>',
    },
    flags: new Set(['\\Seen']),
    bodyStructure: { type: 'text/plain', part: '1' },
  },
];

const { MockImapFlow, behavior, searchCalls } = createImapMock({
  mailboxes: createMailboxes(),
  messages,
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

type Json = Record<string, unknown>;
type ResultMessage = { uid: number; subject: string; from: string; flags: string[] };

describe('email_search_messages — text-search fallback', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    behavior.rejectTextSearch = false;
    behavior.rejectAllSearch = false;
    searchCalls.length = 0;
    vi.unstubAllEnvs();
  });

  /**
   * The provider preset is irrelevant here — what is under test is how the
   * connector reacts to the SERVER's reply to a text SEARCH.
   */
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

  async function search(args: Record<string, unknown>): Promise<Json> {
    const result = await testClient.callTool('email_search_messages', args);
    expect(result.isError).toBeFalsy();
    const json = result.json as Json;
    expect(json.ok).toBe(true);
    return json;
  }

  const uidsOf = (json: Json): number[] =>
    (json.messages as ResultMessage[]).map((message) => message.uid);

  describe('matching', () => {
    it('falls back and matches by subject, newest first, case-insensitively', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const json = await search({ mailbox: 'INBOX', subject: 'quarterly' });

      // 204 ("Re: QUARTERLY planning") and 203 ("Quarterly numbers") match;
      // 205 has "Quarterly" in the SENDER, not the subject; 201 matches the
      // subject but predates the default 90-day window.
      expect(uidsOf(json)).toEqual([204, 203]);
      expect(json.searchMode).toBe('local-filter');
      expect(json.hasMore).toBeUndefined();
    });

    it('matches by sender display name', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const json = await search({ mailbox: 'INBOX', from: 'quarterly' });

      // Only 205's sender is "Quarterly Digest" — a subject match must not
      // satisfy a sender filter.
      expect(uidsOf(json)).toEqual([205]);
    });

    it('matches by sender address, case-insensitively', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const byAddress = await search({ mailbox: 'INBOX', from: 'VENDOR.EXAMPLE' });
      expect(uidsOf(byAddress)).toEqual([206]);

      const byName = await search({ mailbox: 'INBOX', from: 'zoe' });
      expect(uidsOf(byName)).toEqual([206]);
    });

    it('applies sender and subject filters together', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const json = await search({ mailbox: 'INBOX', subject: 'quarterly', from: 'dave' });
      expect(uidsOf(json)).toEqual([203]);
    });

    it('keeps the untrusted-content envelopes on subject, sender and flags', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const json = await search({ mailbox: 'INBOX', from: 'zoe' });
      const [message] = json.messages as ResultMessage[];

      expect(message!.subject).toBe(
        '<untrusted-content source="external-email">Invoice 4417</untrusted-content>',
      );
      expect(message!.from).toBe(
        '<untrusted-content source="external-email">Zoe Green ' +
          '<zoe@vendor.example></untrusted-content>',
      );
      expect(message!.flags).toEqual([
        '<untrusted-content source="external-email">\\Seen</untrusted-content>',
      ]);
      // The connector-authored note is NOT external text, so it is not enveloped.
      expect(json.note as string).not.toContain('<untrusted-content');
    });

    it('restricts the candidate search to the keys such a server supports', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;
      searchCalls.length = 0;

      const json = await search({ mailbox: 'INBOX', from: 'quarterly', unread: true });

      // Only 202 and 205 are unread, and only 205's sender matches.
      expect(uidsOf(json)).toEqual([205]);

      expect(searchCalls).toHaveLength(2);
      const [rejected, fallback] = searchCalls as Array<Record<string, unknown>>;
      expect(rejected!.from).toBe('quarterly');
      // The retried search drops the text keys and keeps a date bound plus the
      // caller's unread filter.
      expect(fallback!.from).toBeUndefined();
      expect(fallback!.subject).toBeUndefined();
      expect(fallback!.seen).toBe(false);
      expect(fallback!.since).toBeInstanceOf(Date);
    });
  });

  describe('date window', () => {
    it('defaults to a 90-day window and reports it', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const json = await search({ mailbox: 'INBOX', subject: 'quarterly' });

      // 201 is 200 days old: outside the default window, so not returned.
      expect(uidsOf(json)).not.toContain(201);

      const searchedSince = new Date(json.searchedSince as string).getTime();
      const expected = NOW - 90 * MS_PER_DAY;
      expect(Math.abs(searchedSince - expected)).toBeLessThan(5 * 60 * 1000);

      const note = json.note as string;
      expect(note).toContain('cannot search by sender or subject');
      expect(note).toContain((json.searchedSince as string).slice(0, 10));
      expect(note).toContain('`since`');
    });

    it("honours the caller's since and reaches older messages", async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const since = daysAgo(365).toISOString();
      const json = await search({ mailbox: 'INBOX', subject: 'quarterly', since });

      expect(uidsOf(json)).toEqual([204, 203, 201]);
      expect(json.searchedSince).toBe(since);
      expect(json.note as string).toContain(since.slice(0, 10));
    });
  });

  describe('paging', () => {
    it('pages with limit/hasMore/nextBeforeUid without gaps or duplicates', async () => {
      await setupClient();
      behavior.rejectTextSearch = true;

      const since = daysAgo(365).toISOString();
      const seen: number[] = [];

      const page1 = await search({ mailbox: 'INBOX', subject: 'quarterly', since, limit: 1 });
      expect(uidsOf(page1)).toEqual([204]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextBeforeUid).toBe(204);
      seen.push(...uidsOf(page1));

      const page2 = await search({
        mailbox: 'INBOX',
        subject: 'quarterly',
        since,
        limit: 1,
        before_uid: page1.nextBeforeUid as number,
      });
      expect(uidsOf(page2)).toEqual([203]);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextBeforeUid).toBe(203);
      seen.push(...uidsOf(page2));

      const page3 = await search({
        mailbox: 'INBOX',
        subject: 'quarterly',
        since,
        limit: 1,
        before_uid: page2.nextBeforeUid as number,
      });
      expect(uidsOf(page3)).toEqual([201]);
      // Nothing older than 201 is left to scan.
      expect(page3.hasMore).toBeUndefined();
      expect(page3.nextBeforeUid).toBeUndefined();
      seen.push(...uidsOf(page3));

      // Every match exactly once, newest first.
      expect(seen).toEqual([204, 203, 201]);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  describe('unrecoverable rejections', () => {
    it('errors instead of returning an empty page when there is nothing to filter on', async () => {
      await setupClient();
      behavior.rejectAllSearch = true;

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        unread: true,
      });

      expect(result.isError).toBe(true);
      const json = result.json as Json;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('SEARCH_REJECTED');
      expect(json.error as string).toContain('rejected this search');
      expect(json.error as string).toContain('not an empty mailbox');
      expect(json.messages).toBeUndefined();
    });

    it('errors when the fallback candidate search is rejected too', async () => {
      await setupClient();
      behavior.rejectAllSearch = true;

      const result = await testClient.callTool('email_search_messages', {
        mailbox: 'INBOX',
        subject: 'quarterly',
      });

      expect(result.isError).toBe(true);
      const json = result.json as Json;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('SEARCH_FALLBACK_REJECTED');
      expect(json.error as string).toContain('nothing was searched');
      expect(json.messages).toBeUndefined();
    });
  });

  describe('servers that do support text search', () => {
    it('uses the server-side search and adds no fallback metadata', async () => {
      await setupClient();
      searchCalls.length = 0;

      const json = await search({ mailbox: 'INBOX', subject: 'quarterly' });

      // Server-side SEARCH SUBJECT: no date window is imposed by the
      // connector, so the 200-day-old 201 comes back too.
      expect(uidsOf(json)).toEqual([204, 203, 201]);
      expect(searchCalls).toHaveLength(1);
      expect(json.searchMode).toBeUndefined();
      expect(json.searchedSince).toBeUndefined();
      expect(json.note).toBeUndefined();
    });

    it('still reports a genuinely empty result as an empty page, not an error', async () => {
      await setupClient();

      const json = await search({ mailbox: 'INBOX', subject: 'nothing matches this' });

      expect(json.messages).toEqual([]);
      expect(json.searchMode).toBeUndefined();
      expect(json.note).toBeUndefined();
    });
  });
});
