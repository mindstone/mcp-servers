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
    tool: 'list_files',
    method: 'GET',
    pathname: '/v1.0/me/drive/root/children',
    args: { top: 1 },
  },
  {
    tool: 'get_file',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'download_file',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'search_files',
    method: 'GET',
    pathname: '/v1.0/me/drive/root/search(q=:q)',
    args: { query: 'report', top: 1 },
  },
  {
    tool: 'upload_file',
    method: 'PUT',
    pathname: '/v1.0/me/drive/root:<rest>:/content',
    args: { path: '/notes.txt', content: 'hello' },
  },
  {
    tool: 'upload_file',
    method: 'POST',
    pathname: '/v1.0/me/drive/root:<rest>:/createUploadSession',
    args: {
      path: '/big.bin',
      content: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61).toString('base64'),
      encoding: 'base64',
    },
  },
  {
    tool: 'create_folder',
    method: 'POST',
    pathname: '/v1.0/me/drive/root/children',
    args: { path: '/NewFolder' },
  },
  {
    tool: 'delete_file',
    method: 'DELETE',
    pathname: '/v1.0/me/drive/items/:id',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'copy_file',
    method: 'POST',
    pathname: '/v1.0/me/drive/items/:id/copy',
    args: { sourcePath: '01ABC', destinationPath: '01DEST' },
  },
  {
    tool: 'move_file',
    method: 'PATCH',
    pathname: '/v1.0/me/drive/items/:id',
    args: { sourcePath: '01SRC', destinationPath: '01DEST' },
  },
  {
    tool: 'get_recent',
    method: 'GET',
    pathname: '/v1.0/me/drive/recent',
    args: { top: 1 },
  },
  {
    tool: 'get_shared',
    method: 'GET',
    pathname: '/v1.0/me/drive/sharedWithMe',
    args: { top: 1 },
  },
  {
    tool: 'share_file',
    method: 'POST',
    pathname: '/v1.0/me/drive/items/:id/createLink',
    args: { path: '01ABC123xyz', type: 'view' },
  },
  {
    tool: 'read_text_file',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'read_text_file',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id/content',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'invite_to_file',
    method: 'POST',
    pathname: '/v1.0/me/drive/items/:id/invite',
    args: { path: '01ABC123xyz', recipients: ['jane@example.com'] },
  },
  {
    tool: 'list_file_permissions',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id/permissions',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'revoke_file_permission',
    method: 'DELETE',
    pathname: '/v1.0/me/drive/items/:id/permissions/:permissionId',
    args: { path: '01ABC123xyz', permissionId: 'perm-1' },
  },
  {
    tool: 'list_file_versions',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id/versions',
    args: { path: '01ABC123xyz' },
  },
  {
    tool: 'restore_file_version',
    method: 'POST',
    pathname: '/v1.0/me/drive/items/:id/versions/:versionId/restoreVersion',
    args: { path: '01ABC123xyz', versionId: '1.0' },
  },
  {
    tool: 'list_file_activities',
    method: 'GET',
    pathname: '/v1.0/me/drive/activities',
    args: {},
  },
  {
    tool: 'list_file_activities',
    method: 'GET',
    pathname: '/v1.0/me/drive/items/:id/activities',
    args: { path: '01ABC123xyz' },
  },
];

function matchPath(actual: string, pattern: string): boolean {
  // Replace `<rest>` placeholders with a sentinel before escaping so we can
  // substitute a wildcard regex back in (used for OneDrive paths that embed
  // arbitrary slashes between the literal `:` segments). Then escape regex
  // metachars and turn `:param` shorthand into single-segment matches.
  const REST_SENTINEL = '\u0000REST\u0000';
  const escaped = pattern
    .replace(/<rest>/g, REST_SENTINEL)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '[^/]+')
    .replace(new RegExp(REST_SENTINEL, 'g'), '.+?');
  const regex = new RegExp('^' + escaped + '$');
  return regex.test(actual);
}

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
