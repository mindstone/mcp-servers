/**
 * Mock factory for imapflow module.
 *
 * Creates a mock ImapFlow class that simulates IMAP operations
 * without connecting to a real server.
 */

import { vi } from 'vitest';

export interface MockMailboxEntry {
  path: string;
  specialUse?: string;
  status?: { messages?: number; unseen?: number };
}

export interface MockMessageData {
  uid: number;
  envelope?: {
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    date?: Date;
    messageId?: string;
  };
  flags?: Set<string>;
  bodyStructure?: {
    type: string;
    part?: string;
    childNodes?: Array<{
      type: string;
      part?: string;
      disposition?: string;
      dispositionParameters?: { filename?: string };
      parameters?: { name?: string };
      size?: number;
      childNodes?: unknown[];
    }>;
  };
}

export interface ImapMockOptions {
  mailboxes?: MockMailboxEntry[];
  messages?: MockMessageData[];
  /** If set, connect() throws */
  connectError?: string;
  /** If set, search() returns these UIDs */
  searchUids?: number[];
}

/**
 * Creates mock for the imapflow module.
 */
export function createImapMock(options: ImapMockOptions = {}) {
  const {
    mailboxes = [
      { path: 'INBOX', specialUse: '\\Inbox', status: { messages: 10, unseen: 3 } },
      { path: 'Sent', specialUse: '\\Sent', status: { messages: 5, unseen: 0 } },
      { path: 'Drafts', specialUse: '\\Drafts', status: { messages: 2, unseen: 0 } },
      { path: 'Trash', specialUse: '\\Trash', status: { messages: 1, unseen: 0 } },
    ],
    messages = [],
    connectError,
    searchUids,
  } = options;

  const constructorCalls: unknown[][] = [];

  class MockImapFlow {
    usable = true;
    mailbox: { path: string; uidValidity: bigint } | null = null;

    constructor(...args: unknown[]) {
      constructorCalls.push(args);
    }

    async connect() {
      if (connectError) {
        throw new Error(connectError);
      }
    }

    async logout() {
      this.usable = false;
    }

    close() {
      this.usable = false;
    }

    async noop() {}

    async list(_opts?: unknown) {
      return mailboxes.map((mb) => ({
        path: mb.path,
        specialUse: mb.specialUse,
        status: mb.status,
      }));
    }

    async status(mailboxPath: string, _opts?: unknown) {
      const mb = mailboxes.find(
        (m) => m.path.toLowerCase() === mailboxPath.toLowerCase(),
      );
      return {
        messages: mb?.status?.messages ?? 0,
        unseen: mb?.status?.unseen ?? 0,
      };
    }

    async getMailboxLock(mailboxPath: string) {
      this.mailbox = {
        path: mailboxPath,
        uidValidity: BigInt(1),
      };
      return {
        release: vi.fn(),
      };
    }

    async search(_criteria: unknown, _opts?: unknown) {
      if (searchUids) return searchUids;
      return messages.map((m) => m.uid);
    }

    fetch(_uids: number | number[], _opts?: unknown, _extraOpts?: unknown) {
      const uidsArr = Array.isArray(_uids) ? _uids : [_uids];
      const matchedMessages = messages.filter((m) => uidsArr.includes(m.uid));

      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < matchedMessages.length) {
                const msg = matchedMessages[i++]!;
                return {
                  done: false as const,
                  value: {
                    uid: msg.uid,
                    envelope: msg.envelope,
                    flags: msg.flags ?? new Set<string>(),
                    bodyStructure: msg.bodyStructure,
                  },
                };
              }
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    }

    async fetchOne(uid: number, _opts?: unknown, _extraOpts?: unknown) {
      const msg = messages.find((m) => m.uid === uid);
      if (!msg) return null;
      return {
        uid: msg.uid,
        envelope: msg.envelope,
        flags: msg.flags ?? new Set<string>(),
        bodyStructure: msg.bodyStructure,
      };
    }

    async download(_uid: number, _part: string, _opts?: unknown) {
      const { Readable } = await import('node:stream');
      return {
        content: Readable.from([Buffer.from('Test email body content')]),
      };
    }

    async messageMove(uids: number[], _destination: string, _opts?: unknown) {
      return { uidMap: new Map(uids.map((uid) => [uid, uid + 1000])) };
    }

    async messageCopy(_uids: number[], _destination: string, _opts?: unknown) {
      return { uidMap: new Map() };
    }

    async messageFlagsAdd(_uids: number[], _flags: string[], _opts?: unknown) {
      return true;
    }

    async messageFlagsRemove(_uids: number[], _flags: string[], _opts?: unknown) {
      return true;
    }

    async messageDelete(_uids: number[], _opts?: unknown) {
      return true;
    }

    async append(_mailbox: string, _rawMessage: Buffer, _flags?: string[]) {
      return { uid: 999 };
    }

    async mailboxCreate(_mailbox: string) {
      return true;
    }

    on(_event: string, _handler: (...args: unknown[]) => void) {
      // no-op for mock
    }
  }

  return { MockImapFlow, constructorCalls };
}
