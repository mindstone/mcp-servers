import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

interface ManifestRow {
  tool: string;
  method: string;
  /** Pathname pattern: `:param` matches anything between slashes. */
  pathname: string;
  /** Args that produce the call. */
  args: Record<string, unknown>;
}

/**
 * Pinned per-tool Graph endpoint contract. Acts as a drift-detection gate so
 * a future refactor cannot silently change a tool's underlying request shape.
 */
const MANIFEST: ManifestRow[] = [
  {
    tool: 'list_emails',
    method: 'GET',
    pathname: '/v1.0/me/mailFolders/inbox/messages',
    args: { top: 1 },
  },
  {
    tool: 'get_email',
    method: 'GET',
    pathname: '/v1.0/me/messages/:id',
    args: { id: 'AAMkAGI2' },
  },
  {
    tool: 'list_attachments',
    method: 'GET',
    pathname: '/v1.0/me/messages/:id/attachments',
    args: { id: 'msg-1' },
  },
  {
    tool: 'download_attachment',
    method: 'GET',
    pathname: '/v1.0/me/messages/:id/attachments/:attachmentId',
    args: { id: 'msg-1', attachmentId: 'att-1' },
  },
  {
    tool: 'send_email',
    method: 'POST',
    pathname: '/v1.0/me/sendMail',
    args: { to: ['a@example.com'], subject: 'x', body: 'y' },
  },
  {
    tool: 'search_emails',
    method: 'GET',
    pathname: '/v1.0/me/messages',
    args: { query: 'project' },
  },
  {
    tool: 'reply_to_email',
    method: 'POST',
    pathname: '/v1.0/me/messages/:id/reply',
    args: { id: 'msg-1', body: 'hi' },
  },
  {
    tool: 'forward_email',
    method: 'POST',
    pathname: '/v1.0/me/messages/:id/forward',
    args: { id: 'msg-1', to: 'x@example.com' },
  },
  {
    tool: 'delete_email',
    method: 'POST',
    pathname: '/v1.0/me/messages/:id/move',
    args: { id: 'msg-1' },
  },
  {
    tool: 'list_folders',
    method: 'GET',
    pathname: '/v1.0/me/mailFolders',
    args: {},
  },
  {
    tool: 'move_email',
    method: 'POST',
    pathname: '/v1.0/me/messages/:id/move',
    args: { id: 'msg-1', destinationFolder: 'archive' },
  },
  {
    tool: 'create_reply_draft',
    method: 'POST',
    pathname: '/v1.0/me/messages/:id/createReply',
    args: { id: 'msg-1', body: 'hi' },
  },
  {
    tool: 'create_draft',
    method: 'POST',
    pathname: '/v1.0/me/messages',
    args: { subject: 'x', body: 'y' },
  },
];

function matchPath(actual: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[\.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$',
  );
  return regex.test(actual);
}

// Hostname compared via parsed URL rather than substring search so a malicious
// path component (e.g. `https://evil.example/login.microsoftonline.com/...`)
// cannot impersonate the auth endpoint. Matches CodeQL guidance for
// `js/incomplete-url-substring-sanitization`.
const AUTH_HOST = ['login', 'microsoftonline', 'com'].join('.');
function isAuthEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname === AUTH_HOST;
  } catch {
    return false;
  }
}

describe('request manifest — Graph endpoint contract', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  for (const row of MANIFEST) {
    it(`${row.tool} → ${row.method} ${row.pathname}`, async () => {
      await client.callTool(row.tool, row.args);
      const match = state.requests.find(
        (r) =>
          r.method === row.method &&
          matchPath(r.pathname, row.pathname) &&
          !isAuthEndpoint(r.url),
      );
      expect(
        match,
        `${row.tool}: no ${row.method} request matched ${row.pathname} (saw ${state.requests
          .map((r) => `${r.method} ${r.pathname}`)
          .join(', ')})`,
      ).toBeDefined();
    });
  }
});
