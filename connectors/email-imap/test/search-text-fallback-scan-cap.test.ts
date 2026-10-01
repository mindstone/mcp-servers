/**
 * email_search_messages — the local-filter fallback's scan cap.
 *
 * Split out of search-text-fallback.test.ts because it needs a mailbox bigger
 * than FALLBACK_MAX_SCANNED, and the imapflow mock is built once per file.
 *
 * The cap is the branch that decides whether paging a busy window terminates.
 * A capped page can match NOTHING and must still hand back a cursor, or the
 * caller has no way to reach the older messages behind the cap — and the
 * cursor has to be the lowest UID actually scanned, so the next page resumes
 * strictly below it with nothing scanned twice and nothing skipped.
 *
 * Why the mailbox is filled in beforeAll instead of at module scope, unlike
 * every sibling test here: sizing it needs FALLBACK_MAX_SCANNED, and importing
 * anything out of src/ pulls in imap-client.ts, which imports `imapflow` as a
 * VALUE. A static import of the constant would therefore run the hoisted
 * vi.mock factory below before this file's body had run — i.e. read
 * `MockImapFlow` before it is initialised. So the cap is read through a
 * dynamic import once the mock exists, and the mailbox array (which
 * createImapMock closes over and re-reads on every call) is filled in place.
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { createImapMock, type MockMessageData } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';
import type { ImapFlow } from 'imapflow';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** Filled by beforeAll; the mock reads it on every search/fetch. */
const mockMailbox: MockMessageData[] = [];

const { MockImapFlow, behavior } = createImapMock({
  mailboxes: createMailboxes(),
  messages: mockMailbox,
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

const LOWEST_UID = 1001;

interface ScanCapFixture {
  /** The connector's real FALLBACK_MAX_SCANNED. */
  scanCap: number;
  /**
   * Lowest UID page 1 can reach: the cap stops it after `scanCap` candidates
   * counting down from the newest, so this UID is scanned (and must NOT be
   * returned again by page 2).
   */
  capBoundaryUid: number;
  /**
   * A match immediately below the boundary — if the cursor skipped a UID,
   * this is the match that would vanish.
   */
  boundaryMatchUid: number;
  /** A match further down, to prove paging keeps scanning past the first hit. */
  deepMatchUid: number;
  messages: MockMessageData[];
}

function buildFixture(scanCap: number): ScanCapFixture {
  /** Candidates in the window: 200 more than the scan cap, so page 1 is capped. */
  const total = scanCap + 200;
  const highestUid = LOWEST_UID + total - 1;
  const capBoundaryUid = highestUid - scanCap + 1;

  // Both matches sit below the boundary, so page 1 matches nothing at all.
  const boundaryMatchUid = capBoundaryUid - 1;
  const deepMatchUid = LOWEST_UID + 49;

  const messages: MockMessageData[] = Array.from({ length: total }, (_, index) => {
    const uid = LOWEST_UID + index;
    const subject =
      uid === boundaryMatchUid
        ? 'Needle just below the cap boundary'
        : uid === deepMatchUid
          ? 'Needle deeper down the mailbox'
          : `Routine notice ${uid}`;

    return {
      uid,
      envelope: {
        subject,
        from: [{ name: 'Notices Bot', address: 'notices@example.com' }],
        to: [{ name: 'Test User', address: 'test@icloud.com' }],
        // Newest UID = newest message, every one inside the default 90-day window.
        date: new Date(NOW - (highestUid - uid + 1) * MS_PER_DAY * 0.05),
        messageId: `<notice-${uid}@example.com>`,
      },
      flags: new Set(['\\Seen']),
      bodyStructure: { type: 'text/plain', part: '1' },
    };
  });

  return { scanCap, capBoundaryUid, boundaryMatchUid, deepMatchUid, messages };
}

type Json = Record<string, unknown>;
type ResultMessage = { uid: number; subject: string };

describe('email_search_messages — local-filter scan cap', () => {
  let testClient: Awaited<
    ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>
  >;
  let fixture: ScanCapFixture;

  beforeAll(async () => {
    const { FALLBACK_MAX_SCANNED } = await import('../src/tools/search-fallback.js');
    fixture = buildFixture(FALLBACK_MAX_SCANNED);
    for (const message of fixture.messages) {
      mockMailbox.push(message);
    }
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    behavior.rejectTextSearch = false;
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
    behavior.rejectTextSearch = true;
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

  it('returns a resumable cursor when the cap stops a page that matched nothing', async () => {
    await setupClient();

    const json = await search({ mailbox: 'INBOX', subject: 'needle', limit: 5 });

    // Zero matches, but emphatically not "no messages": both needles are older
    // than the cap could reach this page.
    expect(uidsOf(json)).toEqual([]);
    expect(json.hasMore).toBe(true);
    expect(json.nextBeforeUid).toBe(fixture.capBoundaryUid);
    expect(json.searchMode).toBe('local-filter');
    expect(json.note).toContain(String(fixture.scanCap));
    expect(json.note).toContain('newest');
    expect(json.note).toContain('before_uid');
  });

  it('resumes strictly below the cursor and finds the older matches', async () => {
    await setupClient();

    const page1 = await search({ mailbox: 'INBOX', subject: 'needle', limit: 5 });
    const page2 = await search({
      mailbox: 'INBOX',
      subject: 'needle',
      limit: 5,
      before_uid: page1.nextBeforeUid,
    });

    // Newest-first, and nothing at or above the cursor comes back — page 1
    // already scanned that range, so a repeat would be a duplicate.
    expect(uidsOf(page2)).toEqual([fixture.boundaryMatchUid, fixture.deepMatchUid]);
    expect(uidsOf(page2).every((uid) => uid < (page1.nextBeforeUid as number))).toBe(true);

    // The boundary needle sits one UID below the cursor: it is only reachable
    // if the cursor is exclusive and leaves no gap under the capped page.
    expect(fixture.boundaryMatchUid).toBe((page1.nextBeforeUid as number) - 1);

    // The remaining candidates fit under the cap, so this page is complete.
    expect(page2.hasMore).toBeUndefined();
    expect(page2.nextBeforeUid).toBeUndefined();
    expect(page2.note).not.toContain('newest');
  });

  /**
   * The tool caps `limit` at 500, so a page cannot fill exactly on the cap's
   * last candidate through the tool surface — this one goes at the fallback
   * directly. It is the case a "short page" heuristic gets wrong.
   */
  it('reports the cap even when the page fills exactly on its last candidate', async () => {
    const { searchByLocalFilter } = await import('../src/tools/search-fallback.js');
    const client = new MockImapFlow() as unknown as ImapFlow;

    // Every candidate matches "notice", so the page fills on the same
    // candidate the cap stops at.
    const result = await searchByLocalFilter(client, {
      subject: 'notice',
      unread: false,
      limit: fixture.scanCap,
    });

    expect(result.messages).toHaveLength(fixture.scanCap);
    expect(result.scannedCount).toBe(fixture.scanCap);
    expect(result.hasMore).toBe(true);
    expect(result.nextBeforeUid).toBe(fixture.capBoundaryUid);
    expect(result.scanCapHit).toBe(true);
  });
});
