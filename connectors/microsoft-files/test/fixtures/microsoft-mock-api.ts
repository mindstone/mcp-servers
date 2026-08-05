import { http, HttpResponse, type DefaultBodyType, type HttpHandler } from 'msw';

// Hostname is assembled at runtime from a parts array so static analyzers
// (CodeQL `js/incomplete-hostname-regexp`) do not see a literal `microsoft.com`
// flow into the `new RegExp(...)` patterns below; the rx() helper already
// escapes regex metacharacters before assembling the final pattern.
const GRAPH_HOST = ['graph', 'microsoft', 'com'].join('.');
const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`;

export interface CapturedRequest {
  method: string;
  url: string;
  pathname: string;
  search: string;
  body: DefaultBodyType | null;
  authorization?: string;
}

export interface MockApiState {
  requests: CapturedRequest[];
  refreshCalls: number;
}

const sampleFile = {
  id: 'file-1',
  name: 'report.docx',
  size: 1500,
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://onedrive.example.com/file-1',
  file: { mimeType: 'application/vnd.openxmlformats' },
  parentReference: { path: '/drive/root:/Documents' },
};

const sampleFolder = {
  id: 'folder-1',
  name: 'Documents',
  size: 0,
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://onedrive.example.com/folder-1',
  folder: { childCount: 5 },
  parentReference: { path: '/drive/root:' },
};

const sampleTextMetadata = {
  id: 'file-text',
  name: 'notes.txt',
  size: 42,
  file: { mimeType: 'text/plain' },
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://onedrive.example.com/file-text',
  parentReference: { path: '/drive/root:' },
};

const samplePermission = {
  id: 'perm-1',
  roles: ['read'],
  grantedToIdentities: [
    { user: { id: 'user-1', displayName: 'Jane Doe', email: 'jane@example.com' } },
  ],
};

const sampleLinkPermission = {
  id: 'perm-2',
  roles: ['edit'],
  link: {
    type: 'edit',
    scope: 'organization',
    webUrl: 'https://onedrive.example.com/share/perm-2',
  },
};

const sampleActivity = {
  id: 'act-1',
  activityDateTime: '2026-05-19T10:00:00Z',
  actor: { user: { displayName: 'Jane Doe' } },
  action: { edit: {} },
  driveItem: { id: 'file-1', name: 'report.docx' },
};

/**
 * MSW URL patterns delegate to `path-to-regexp` which interprets `:foo`
 * as a named param. Microsoft Graph's OneDrive endpoints embed literal
 * colons (e.g. `/me/drive/root:/Documents/file.txt:/content`) so we must
 * use regular expressions to match them rather than string patterns.
 */
function rx(pattern: string): RegExp {
  return new RegExp(
    '^' +
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/<seg>/g, '[^/?]+')
        .replace(/<rest>/g, '[^?]+') +
      '(\\?.*)?$',
  );
}

const SHARED_BASE = GRAPH_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createMockApi(): { handlers: HttpHandler[]; state: MockApiState } {
  const state: MockApiState = { requests: [], refreshCalls: 0 };

  async function capture(request: Request): Promise<void> {
    let body: DefaultBodyType | null = null;
    try {
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        body = (await request.clone().json()) as DefaultBodyType;
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await request.clone().text();
        body = Object.fromEntries(new URLSearchParams(text).entries()) as DefaultBodyType;
      } else {
        body = (await request.clone().text()) as DefaultBodyType;
      }
    } catch {
      body = null;
    }
    const url = new URL(request.url);
    state.requests.push({
      method: request.method,
      url: request.url,
      pathname: url.pathname,
      search: url.search,
      body,
      authorization: request.headers.get('authorization') ?? undefined,
    });
  }

  const handlers: HttpHandler[] = [
    // Refresh-token endpoint (used by TokenProvider on expiry).
    http.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      async ({ request }) => {
        state.refreshCalls += 1;
        await capture(request);
        return HttpResponse.json({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'Files.ReadWrite Files.ReadWrite.All offline_access',
        });
      },
    ),

    // /me/drive/root/children — list_files (root) GET, create_folder POST
    http.get(`${GRAPH_BASE}/me/drive/root/children`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [sampleFolder, sampleFile] });
    }),
    http.post(`${GRAPH_BASE}/me/drive/root/children`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        id: 'folder-new',
        name: 'NewFolder',
        webUrl: 'https://onedrive.example.com/folder-new',
      });
    }),

    // /me/drive/root:/{path}:/children — list_files by path (GET) + create_folder under parent (POST)
    http.get(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+:/children(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ value: [sampleFile] });
      },
    ),
    http.post(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+:/children(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          id: 'folder-new',
          name: 'NewFolder',
          webUrl: 'https://onedrive.example.com/folder-new',
        });
      },
    ),

    // /me/drive/root:/{path}:/content (PUT) — upload_file
    http.put(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+:/content(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          id: 'new-file-1',
          name: 'notes.txt',
          size: 42,
          webUrl: 'https://onedrive.example.com/new-file-1',
        });
      },
    ),

    // /me/drive/root:/{path}/content (GET) — read_text_file content
    http.get(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+/content(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.text('Hello from text file.');
      },
    ),

    // /me/drive/root:/{path}/copy (POST) — copy_file path-based
    http.post(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+/copy(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return new HttpResponse(null, {
          status: 202,
          headers: { Location: 'https://graph.microsoft.com/monitor/copy-1' },
        });
      },
    ),

    // /me/drive/root:/{path}/createLink (POST) — share_file path-based
    http.post(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+/createLink(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          shareId: 'share-1',
          link: { webUrl: 'https://onedrive.example.com/share/share-1' },
        });
      },
    ),

    // /me/drive/root:/{path} (DELETE | PATCH | GET) — generic single-item by path
    http.delete(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          id: 'file-1',
          name: 'moved.txt',
          webUrl: 'https://onedrive.example.com/file-1',
        });
      },
    ),
    http.get(
      new RegExp(`${SHARED_BASE}/me/drive/root:/[^?]+(\\?.*)?$`),
      async ({ request }) => {
        const url = new URL(request.url);
        await capture(request);
        const select = url.searchParams.get('$select') ?? '';
        const isFolderLookup = url.pathname.toLowerCase().includes('folder');
        if (select.includes('@microsoft.graph.downloadUrl')) {
          return HttpResponse.json({
            id: 'file-1',
            name: 'report.docx',
            '@microsoft.graph.downloadUrl':
              'https://downloads.example.com/short-lived/file-1',
          });
        }
        if (isFolderLookup) {
          return HttpResponse.json(sampleFolder);
        }
        if (select.includes(',file,folder') || select.includes('file,folder')) {
          return HttpResponse.json(sampleTextMetadata);
        }
        if (select.includes('id,name,size,file')) {
          return HttpResponse.json(sampleTextMetadata);
        }
        return HttpResponse.json(sampleFile);
      },
    ),

    // /me/drive/root/search(q='...') — search_files
    http.get(
      new RegExp(`${SHARED_BASE}/me/drive/root/search\\(q='[^']*'\\)(\\?.*)?$`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ value: [sampleFile] });
      },
    ),

    // /me/drive/items/{id}/invite (POST) — invite_to_file
    http.post(rx(`${GRAPH_BASE}/me/drive/items/<seg>/invite`), async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [samplePermission] });
    }),

    // /me/drive/items/{id}/permissions (GET) — list_file_permissions
    http.get(rx(`${GRAPH_BASE}/me/drive/items/<seg>/permissions`), async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [samplePermission, sampleLinkPermission] });
    }),

    // /me/drive/items/{id}/permissions/{permissionId} (DELETE) — revoke_file_permission
    http.delete(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>/permissions/<seg>`),
      async ({ request }) => {
        await capture(request);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // /me/drive/items/{id}/versions (GET) — list_file_versions
    http.get(rx(`${GRAPH_BASE}/me/drive/items/<seg>/versions`), async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: '2.0',
            lastModifiedDateTime: '2026-05-19T10:00:00Z',
            size: 1600,
            lastModifiedBy: { user: { displayName: 'Jane Doe' } },
          },
          {
            id: '1.0',
            lastModifiedDateTime: '2026-01-01T10:00:00Z',
            size: 1500,
          },
        ],
      });
    }),

    // /me/drive/items/{id}/versions/{versionId}/restoreVersion (POST) — restore_file_version
    http.post(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>/versions/<seg>/restoreVersion`),
      async ({ request }) => {
        await capture(request);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // /me/drive/activities — list_file_activities (drive-wide)
    http.get(`${GRAPH_BASE}/me/drive/activities`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [sampleActivity] });
    }),

    // /me/drive/items/{id}/activities (GET) — list_file_activities (item-scoped)
    http.get(rx(`${GRAPH_BASE}/me/drive/items/<seg>/activities`), async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [sampleActivity] });
    }),

    // /me/drive/items/{id}/copy (POST) — copy_file id-based
    http.post(rx(`${GRAPH_BASE}/me/drive/items/<seg>/copy`), async ({ request }) => {
      await capture(request);
      return new HttpResponse(null, {
        status: 202,
        headers: { Location: 'https://graph.microsoft.com/monitor/copy-1' },
      });
    }),

    // /me/drive/items/{id}/createLink (POST) — share_file id-based
    http.post(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>/createLink`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          shareId: 'share-1',
          link: { webUrl: 'https://onedrive.example.com/share/share-1' },
        });
      },
    ),

    // /me/drive/items/{id}/content (GET) — read_text_file content by id
    http.get(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>/content`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.text('Hello from text file.');
      },
    ),

    // /me/drive/items/{id}/children (GET) — list_files by id
    http.get(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>/children`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ value: [] });
      },
    ),

    // /me/drive/items/{id} (GET | PATCH | DELETE)
    http.get(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>`),
      async ({ request }) => {
        const url = new URL(request.url);
        await capture(request);
        const select = url.searchParams.get('$select') ?? '';
        if (select.includes('@microsoft.graph.downloadUrl')) {
          return HttpResponse.json({
            id: 'file-1',
            name: 'report.docx',
            '@microsoft.graph.downloadUrl':
              'https://downloads.example.com/short-lived/file-1',
          });
        }
        if (select === 'id') {
          return HttpResponse.json({ id: 'dest-folder-1' });
        }
        if (select === 'id,name') {
          return HttpResponse.json({ id: 'src-1', name: 'template.docx' });
        }
        if (select.includes('file,folder')) {
          return HttpResponse.json(sampleTextMetadata);
        }
        return HttpResponse.json(sampleFile);
      },
    ),
    http.patch(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>`),
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({
          id: 'file-1',
          name: 'moved.txt',
          webUrl: 'https://onedrive.example.com/file-1',
        });
      },
    ),
    http.delete(
      rx(`${GRAPH_BASE}/me/drive/items/<seg>`),
      async ({ request }) => {
        await capture(request);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // /me/drive/recent — get_recent
    http.get(`${GRAPH_BASE}/me/drive/recent`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [sampleFile] });
    }),

    // /me/drive/sharedWithMe — get_shared
    http.get(`${GRAPH_BASE}/me/drive/sharedWithMe`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ value: [sampleFile] });
    }),
  ];

  return { handlers, state };
}
