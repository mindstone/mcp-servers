/**
 * Outbound attachments on email_send / email_save_draft — workspace-sandbox
 * containment (reads confined to MCP_WORKSPACE_PATH), filename sanitization,
 * and count/size caps.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { createMailboxes, createMessages } from './fixtures/email-data.js';

const { MockImapFlow } = createImapMock({
  mailboxes: createMailboxes(),
  messages: createMessages(),
});
const { createTransport: mockCreateTransport, mockTransport, streamTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('outbound attachments (email_send / email_save_draft)', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;
  let workspace: string;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (workspace) {
      fs.rmSync(workspace, { recursive: true, force: true });
      workspace = '';
    }
  });

  async function setupClient() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-send-test-'));
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

  it('email_send attaches a workspace file by canonical path', async () => {
    await setupClient();
    const filePath = path.join(workspace, 'note.txt');
    fs.writeFileSync(filePath, 'hello attachment');

    const result = await testClient.callTool('email_send', {
      to: 'alice@example.com',
      subject: 'Hi',
      text: 'See attached',
      attachments: [{ path: filePath }],
    });
    expect(result.isError).toBeFalsy();

    expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransport.sendMail.mock.calls[0]![0] as {
      attachments?: Array<{ path: string }>;
    };
    expect(sent.attachments).toEqual([{ path: fs.realpathSync(filePath) }]);
  });

  it('sanitizes the optional display filename to a basename', async () => {
    await setupClient();
    const filePath = path.join(workspace, 'note.txt');
    fs.writeFileSync(filePath, 'hello attachment');

    const result = await testClient.callTool('email_send', {
      to: 'alice@example.com',
      text: 'See attached',
      attachments: [{ path: filePath, filename: '../evil.txt' }],
    });
    expect(result.isError).toBeFalsy();

    const sent = mockTransport.sendMail.mock.calls[0]![0] as {
      attachments?: Array<{ filename?: string }>;
    };
    expect(sent.attachments![0]!.filename).toBe('evil.txt');
  });

  it('refuses a path outside the workspace sandbox before any send', async () => {
    await setupClient();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'top secret');
    // workspace itself lives under os.tmpdir(), so use a file that is
    // definitely outside the workspace root.
    expect(fs.realpathSync(outsideFile).startsWith(fs.realpathSync(workspace) + path.sep)).toBe(false);

    const result = await testClient.callTool('email_send', {
      to: 'alice@example.com',
      text: 'See attached',
      attachments: [{ path: outsideFile }],
    });
    expect(result.isError).toBe(true);
    const json = result.json as Record<string, unknown>;
    expect(json.error as string).toContain('workspace sandbox');
    expect(mockTransport.sendMail).not.toHaveBeenCalled();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses an in-workspace symlink that points outside the sandbox', async () => {
    await setupClient();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'top secret');
    const linkPath = path.join(workspace, 'link.txt');
    fs.symlinkSync(outsideFile, linkPath);

    const result = await testClient.callTool('email_send', {
      to: 'alice@example.com',
      text: 'See attached',
      attachments: [{ path: linkPath }],
    });
    expect(result.isError).toBe(true);
    const json = result.json as Record<string, unknown>;
    // Refused at the canonical-prefix containment step (the symlink target
    // canonicalises to a path outside the workspace root).
    expect(json.error as string).toContain('workspace sandbox');
    expect(mockTransport.sendMail).not.toHaveBeenCalled();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects more than 10 attachments via schema validation', async () => {
    await setupClient();

    const result = await testClient.callTool('email_send', {
      to: 'alice@example.com',
      text: 'See attached',
      attachments: Array.from({ length: 11 }, (_, i) => ({ path: `file-${i}.txt` })),
    });
    expect(result.isError).toBe(true);
    expect(mockTransport.sendMail).not.toHaveBeenCalled();
  });

  it('email_save_draft attaches workspace files to the stored draft', async () => {
    await setupClient();
    const filePath = path.join(workspace, 'draft-note.txt');
    fs.writeFileSync(filePath, 'draft attachment');

    const result = await testClient.callTool('email_save_draft', {
      to: 'alice@example.com',
      subject: 'Draft',
      text: 'Draft body',
      attachments: [{ path: filePath }],
    });
    expect(result.isError).toBeFalsy();

    expect(streamTransport.sendMail).toHaveBeenCalledTimes(1);
    const sent = streamTransport.sendMail.mock.calls[0]![0] as {
      attachments?: Array<{ path: string }>;
    };
    expect(sent.attachments).toEqual([{ path: fs.realpathSync(filePath) }]);
  });
});
