import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';

// Create mocks before any module imports
const { MockImapFlow } = createImapMock();
const { createTransport: mockCreateTransport } = createSmtpMock();

// Mock imapflow and nodemailer at module level
vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Smoke test — tool registration', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 9 tools with correct names', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: 'test@icloud.com',
        EMAIL_IMAP_PASSWORD: 'test-app-password',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(9);
    expect(toolNames).toEqual([
      'configure_email_imap',
      'email_get_mailbox_status',
      'email_get_message',
      'email_list_mailboxes',
      'email_move_messages',
      'email_save_draft',
      'email_search_messages',
      'email_send',
      'email_set_flags',
    ]);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 9 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone-engineering/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        // No credentials — server should still start and list tools
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(9);
    } finally {
      await client.close();
    }
  });
});
