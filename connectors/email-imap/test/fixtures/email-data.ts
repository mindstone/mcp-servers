/**
 * Factory functions for email-imap test data.
 */

import type { MockMailboxEntry, MockMessageData } from '../helpers/imap-mock.js';

export function createMailboxes(): MockMailboxEntry[] {
  return [
    { path: 'INBOX', specialUse: '\\Inbox', status: { messages: 10, unseen: 3 } },
    { path: 'Sent Messages', specialUse: '\\Sent', status: { messages: 25, unseen: 0 } },
    { path: 'Drafts', specialUse: '\\Drafts', status: { messages: 2, unseen: 0 } },
    { path: 'Deleted Messages', specialUse: '\\Trash', status: { messages: 5, unseen: 0 } },
    { path: 'Junk', specialUse: '\\Junk', status: { messages: 8, unseen: 8 } },
    { path: 'Archive', status: { messages: 100, unseen: 0 } },
  ];
}

export function createMessages(): MockMessageData[] {
  return [
    {
      uid: 101,
      envelope: {
        subject: 'Welcome to the service',
        from: [{ name: 'Support Team', address: 'support@example.com' }],
        to: [{ name: 'Test User', address: 'test@icloud.com' }],
        date: new Date('2026-01-15T10:00:00Z'),
        messageId: '<welcome-123@example.com>',
      },
      flags: new Set(['\\Seen']),
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          { type: 'text/plain', part: '1' },
          { type: 'text/html', part: '2' },
        ],
      },
    },
    {
      uid: 102,
      envelope: {
        subject: 'Meeting tomorrow',
        from: [{ name: 'Alice Smith', address: 'alice@example.com' }],
        to: [{ name: 'Test User', address: 'test@icloud.com' }],
        date: new Date('2026-01-16T14:30:00Z'),
        messageId: '<meeting-456@example.com>',
      },
      flags: new Set(),
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          {
            type: 'text/plain',
            part: '1',
          },
          {
            type: 'application/pdf',
            part: '2',
            disposition: 'attachment',
            dispositionParameters: { filename: 'agenda.pdf' },
            size: 15360,
          },
        ],
      },
    },
    {
      uid: 103,
      envelope: {
        subject: 'Project update',
        from: [{ name: 'Bob Jones', address: 'bob@example.com' }],
        to: [{ name: 'Test User', address: 'test@icloud.com' }],
        date: new Date('2026-01-17T09:00:00Z'),
        messageId: '<project-789@example.com>',
      },
      flags: new Set(['\\Flagged']),
      bodyStructure: {
        type: 'text/plain',
        part: '1',
      },
    },
  ];
}
