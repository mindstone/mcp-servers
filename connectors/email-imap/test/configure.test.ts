import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';
import { mswServer } from './helpers/setup.js';
import { createBridgeHandlers } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

const { MockImapFlow } = createImapMock();
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

describe('Configure tool', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('configures credentials successfully without bridge', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'user@icloud.com',
      password: 'app-specific-pwd',
      provider: 'icloud',
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toContain('iCloud Mail');
    expect(json.provider).toBe('icloud');
  });

  it('Zod rejects malformed input — empty email', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: '',
      password: 'test-pass',
    });

    expect(result.isError).toBe(true);
  });

  it('Zod rejects malformed input — missing password', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_email_imap', {
      email: 'test@icloud.com',
    });

    expect(result.isError).toBe(true);
  });

  // VAL-EMAIL-026 — configure_email_imap MUST NOT silently default to icloud
  // when neither a `provider` argument nor `EMAIL_IMAP_PROVIDER` env var is
  // set. Behaviour must match index.ts startup (M3.4): auto-detect via
  // detectProviderFromEmail and refuse unknown domains with a clear error.
  describe('VAL-EMAIL-026 — provider auto-detect parity (no silent iCloud fallback)', () => {
    it.each([
      {
        case: 'auto-detects gmail from email when no provider arg or env is set',
        email: 'alice@gmail.com',
        expectIsError: false,
        expectProvider: 'gmail',
      },
      {
        case: 'unknown domain refuses with provider-detection error',
        email: 'x@unknown.example',
        expectIsError: true,
        expectProvider: undefined,
      },
    ])('$case', async ({ email, expectIsError, expectProvider }) => {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');

      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: '',
          EMAIL_IMAP_PASSWORD: '',
          EMAIL_IMAP_PROVIDER: '',
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_email_imap', {
        email,
        password: 'app-specific-pwd',
      });

      if (expectIsError) {
        expect(result.isError).toBe(true);
        const json = result.json as Record<string, unknown>;
        expect(json.ok).toBe(false);
        const errorMsg = String(json.error ?? '').toLowerCase();
        expect(errorMsg).toMatch(/provider/);
        expect(errorMsg).toMatch(/detect|unknown|unrecognis|set email_imap_provider/);
        // Defence-in-depth: must not silently resolve to icloud anywhere.
        expect(json.provider).not.toBe('icloud');
      } else {
        expect(result.isError).toBeFalsy();
        const json = result.json as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.provider).toBe(expectProvider);
      }
    });
  });

  it('unconfigured tool calls return error with resolution hint', async () => {
    const { createTestClient } = await import('./helpers/mcp-test-client.js');

    testClient = await createTestClient({
      env: {
        EMAIL_IMAP_EMAIL: '',
        EMAIL_IMAP_PASSWORD: '',
        EMAIL_IMAP_PROVIDER: 'icloud',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('email_list_mailboxes', {});
    expect(result.isError).toBe(true);

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not initialized');
  });
});

describe('Bridge integration', () => {
  let testClient: Awaited<ReturnType<typeof import('./helpers/mcp-test-client.js').createTestClient>>;
  const BRIDGE_PORT = 39100;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined as unknown as typeof testClient;
    }
    vi.unstubAllEnvs();
  });

  it('configure via bridge success', async () => {
    // Write a temporary bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: 'test-token' }));

    // Set up bridge mock
    mswServer.use(...createBridgeHandlers(BRIDGE_PORT));

    try {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');

      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: '',
          EMAIL_IMAP_PASSWORD: '',
          EMAIL_IMAP_PROVIDER: 'icloud',
          MCP_HOST_BRIDGE_STATE: bridgePath,
          MINDSTONE_REBEL_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_email_imap', {
        email: 'user@icloud.com',
        password: 'app-password',
        provider: 'icloud',
      });

      expect(result.isError).toBeFalsy();
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridge 401 returns isError:true (not silent fallback)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: 'bad-token' }));

    // Bridge rejects ALL requests with 401
    mswServer.use(
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/*`, () => {
        return HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }),
    );

    try {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');

      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: '',
          EMAIL_IMAP_PASSWORD: '',
          EMAIL_IMAP_PROVIDER: 'icloud',
          MCP_HOST_BRIDGE_STATE: bridgePath,
          MINDSTONE_REBEL_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_email_imap', {
        email: 'user@icloud.com',
        password: 'app-password',
        provider: 'icloud',
      });

      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridge 403 returns isError:true (not silent fallback)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: 'bad-token' }));

    mswServer.use(
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/*`, () => {
        return HttpResponse.json(
          { success: false, error: 'Forbidden' },
          { status: 403 },
        );
      }),
    );

    try {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');

      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: '',
          EMAIL_IMAP_PASSWORD: '',
          EMAIL_IMAP_PROVIDER: 'icloud',
          MCP_HOST_BRIDGE_STATE: bridgePath,
          MINDSTONE_REBEL_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_email_imap', {
        email: 'user@icloud.com',
        password: 'app-password',
        provider: 'icloud',
      });

      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridge { success: false } returns isError:true', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-imap-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: 'test-token' }));

    // Bridge returns 200 but success: false
    mswServer.use(
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/*`, ({ request }) => {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          return HttpResponse.json({ success: false }, { status: 401 });
        }
        return HttpResponse.json({ success: false, error: 'Account not found' });
      }),
    );

    try {
      const { createTestClient } = await import('./helpers/mcp-test-client.js');

      testClient = await createTestClient({
        env: {
          EMAIL_IMAP_EMAIL: '',
          EMAIL_IMAP_PASSWORD: '',
          EMAIL_IMAP_PROVIDER: 'icloud',
          MCP_HOST_BRIDGE_STATE: bridgePath,
          MINDSTONE_REBEL_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_email_imap', {
        email: 'user@icloud.com',
        password: 'app-password',
        provider: 'icloud',
      });

      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
