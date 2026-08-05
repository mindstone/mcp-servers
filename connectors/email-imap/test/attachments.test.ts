/**
 * email_get_attachment — downloads MIME attachment parts into the workspace
 * sandbox (MCP_WORKSPACE_PATH or os.tmpdir()), with filename sanitization and
 * canonical-prefix containment.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImapMock, type MockMessageData } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes } from './fixtures/email-data.js';

const fixtureMessages: MockMessageData[] = [
  // 401: attachment with a traversal-shaped filename.
  {
    uid: 401,
    envelope: {
      subject: 'Invoice',
      from: [{ name: 'Billing', address: 'billing@example.com' }],
      date: new Date('2026-03-01T10:00:00Z'),
    },
    flags: new Set(),
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        {
          type: 'application/pdf',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: '../../evil.pdf' },
          size: 128,
        },
      ],
    },
    bodyByPart: { '1': 'See attached.', '2': 'PDF-CONTENT-401' },
  },
  // 402: ordinary attachment with a per-part body.
  {
    uid: 402,
    envelope: {
      subject: 'Report',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      date: new Date('2026-03-02T10:00:00Z'),
    },
    flags: new Set(),
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        {
          type: 'application/pdf',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          size: 256,
        },
      ],
    },
    bodyByPart: { '1': 'Report attached.', '2': 'PDF-CONTENT-402' },
  },
  // 403: no attachments at all.
  {
    uid: 403,
    envelope: {
      subject: 'Plain',
      from: [{ name: 'Bob', address: 'bob@example.com' }],
      date: new Date('2026-03-03T10:00:00Z'),
    },
    flags: new Set(),
    bodyStructure: { type: 'text/plain', part: '1' },
    bodyByPart: { '1': 'No attachments here.' },
  },
];

const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: fixtureMessages,
});
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('email_get_attachment', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;
  let workspace: string;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
    if (workspace) {
      fs.rmSync(workspace, { recursive: true, force: true });
      workspace = '';
    }
  });

  async function setupClient() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-test-'));
    const { createTestClient } = await import('./helpers/mcp-test-client.js');
    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-pass',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });
    await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
      password: 'test-pass',
      provider: 'icloud',
    });
    return testClient;
  }

  it('downloads an attachment into the workspace sandbox', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '2',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.contentType).toBe(
      '<untrusted-content source="external-email">application/pdf</untrusted-content>',
    );
    expect(json.sizeBytes).toBe(Buffer.byteLength('PDF-CONTENT-402'));

    const savedPath = json.path as string;
    const canonicalRoot = fs.realpathSync(workspace);
    expect(savedPath.startsWith(canonicalRoot + path.sep)).toBe(true);
    expect(path.basename(savedPath)).toBe('report.pdf');
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('PDF-CONTENT-402');
  });

  it('sanitizes traversal-shaped attachment filenames into the sandbox', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 401,
      part: '2',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    const savedPath = json.path as string;
    const canonicalRoot = fs.realpathSync(workspace);
    expect(savedPath.startsWith(canonicalRoot + path.sep)).toBe(true);
    expect(path.basename(savedPath)).toBe('evil.pdf');
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('PDF-CONTENT-401');
  });

  it('honours a filename override (basename only)', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '2',
      filename: 'nested/renamed.pdf',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(path.basename(json.path as string)).toBe('renamed.pdf');
  });

  it('never overwrites an existing download: same attachment downloaded twice lands at distinct paths', async () => {
    await setupClient();

    const first = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '2',
    });
    expect(first.isError).toBeFalsy();
    const firstPath = (first.json as Record<string, unknown>).path as string;

    const second = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '2',
    });
    expect(second.isError).toBeFalsy();
    const secondPath = (second.json as Record<string, unknown>).path as string;

    expect(secondPath).not.toBe(firstPath);
    expect(fs.readFileSync(firstPath, 'utf8')).toBe('PDF-CONTENT-402');
    expect(fs.readFileSync(secondPath, 'utf8')).toBe('PDF-CONTENT-402');
  });

  it('errors when the part is not an attachment on the message', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '9',
    });
    expect(result.isError).toBe(true);
    const json = result.json as Record<string, unknown>;
    expect(json.error as string).toContain('No attachment part "9"');
  });

  it('accepts an enveloped part identifier round-tripped from email_get_message', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
      part: '<untrusted-content source="external-email">2</untrusted-content>',
    });
    expect(result.isError).toBeFalsy();

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.part).toBe('2');
    expect(fs.readFileSync(json.path as string, 'utf8')).toBe('PDF-CONTENT-402');
  });

  it('errors when the message has no attachments', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 403,
      part: '2',
    });
    expect(result.isError).toBe(true);
    const json = result.json as Record<string, unknown>;
    expect(json.error as string).toContain('no attachments');
  });

  it('errors for an unknown message UID', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 999,
      part: '2',
    });
    expect(result.isError).toBe(true);
  });

  it('validates part is required', async () => {
    await setupClient();

    const result = await testClient.callTool('email_get_attachment', {
      mailbox: 'INBOX',
      uid: 402,
    });
    expect(result.isError).toBe(true);
  });
});
