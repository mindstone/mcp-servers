import { http, HttpResponse, type DefaultBodyType, type HttpHandler } from 'msw';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

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
const site = {
  id: 'site-1',
  displayName: 'Marketing',
  name: 'Marketing',
  webUrl: 'https://contoso.sharepoint.com/sites/Marketing',
  description: 'Marketing site',
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  root: {},
  siteCollection: { hostname: 'contoso.sharepoint.com' },
};

const drive = {
  id: 'drive-1',
  name: 'Documents',
  description: 'Shared docs',
  driveType: 'documentLibrary',
  webUrl: 'https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents',
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  quota: { total: 1000000, used: 250000, remaining: 750000, state: 'normal' },
};

const fileItem = {
  id: 'item-1',
  name: 'notes.txt',
  size: 42,
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://contoso.sharepoint.com/file/item-1',
  file: { mimeType: 'text/plain' },
  parentReference: {
    path: '/drives/drive-1/root:/General',
    driveId: 'drive-1',
    siteId: 'site-1',
  },
  '@microsoft.graph.downloadUrl': 'https://downloads.example.com/item-1',
};

const folderItem = {
  id: 'folder-1',
  name: 'General',
  size: 0,
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://contoso.sharepoint.com/folder/folder-1',
  folder: { childCount: 2 },
  parentReference: {
    path: '/drives/drive-1/root:',
    driveId: 'drive-1',
    siteId: 'site-1',
  },
};

const listEntity = {
  id: 'list-1',
  displayName: 'Tasks',
  name: 'Tasks',
  description: 'Task tracker',
  webUrl: 'https://contoso.sharepoint.com/sites/Marketing/Lists/Tasks',
  createdDateTime: '2026-01-01T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  list: { template: 'genericList', hidden: false, contentTypesEnabled: true },
};

const listItem = {
  id: '1',
  createdDateTime: '2026-05-18T10:00:00Z',
  lastModifiedDateTime: '2026-05-19T10:00:00Z',
  webUrl: 'https://contoso.sharepoint.com/sites/Marketing/Lists/Tasks/1_.000',
  fields: { Title: 'Task A', Status: 'Active' },
};

const permission = {
  id: 'perm-1',
  roles: ['read'],
  shareId: 's!abc123',
  link: {
    type: 'view',
    scope: 'users',
    webUrl: 'https://contoso.sharepoint.com/share/perm-1',
  },
  grantedToV2: { user: { displayName: 'Alice Example', email: 'alice@example.com' } },
};

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
          scope: 'Sites.Read.All Files.ReadWrite Files.ReadWrite.All offline_access',
        });
      },
    ),
    http.all(/^https:\/\/graph\.microsoft\.com\/v1\.0\/.*/, async ({ request }) => {
      await capture(request);
      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = request.method.toUpperCase();

      if (method === 'GET' && pathname === '/v1.0/sites') {
        return HttpResponse.json({ value: [site] });
      }

      if (method === 'GET' && pathname === '/v1.0/sites/delta()') {
        return HttpResponse.json({
          value: [site],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/sites/delta(token)',
        });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/drives$/.test(pathname)) {
        return HttpResponse.json({ value: [drive] });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/drives\/[^/]+$/.test(pathname)) {
        return HttpResponse.json(drive);
      }

      if (method === 'POST' && /^\/v1\.0\/sites\/[^/]+\/pages$/.test(pathname)) {
        return HttpResponse.json(
          {
            '@odata.type': '#microsoft.graph.sitePage',
            id: 'page-new',
            name: 'q3-update.aspx',
            title: 'Q3 Update',
            webUrl: 'https://contoso.sharepoint.com/sites/Marketing/SitePages/q3-update.aspx',
            pageLayout: 'article',
            publishingState: { level: 'checkout', versionId: '0.1' },
          },
          { status: 201 },
        );
      }

      if (method === 'POST' && /\/microsoft\.graph\.sitePage\/publish$/.test(pathname)) {
        return new HttpResponse(null, { status: 204 });
      }

      if (method === 'PATCH' && /\/microsoft\.graph\.sitePage$/.test(pathname)) {
        return HttpResponse.json({
          id: 'page-1',
          title: 'Updated title',
          name: 'home.aspx',
          webUrl: 'https://contoso.sharepoint.com/sites/Marketing/SitePages/home.aspx',
          publishingState: { level: 'draft', versionId: '1.1' },
        });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/pages$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            {
              id: 'page-1',
              title: 'Home',
              name: 'home.aspx',
              webUrl: 'https://contoso.sharepoint.com/sites/Marketing/SitePages/home.aspx',
              description: 'Home page',
              createdDateTime: '2026-01-01T10:00:00Z',
              lastModifiedDateTime: '2026-05-19T10:00:00Z',
              createdBy: { user: { displayName: 'Alice' } },
              lastModifiedBy: { user: { displayName: 'Bob' } },
            },
          ],
        });
      }

      if (method === 'GET' && /\/microsoft\.graph\.sitePage\/webParts$/.test(pathname)) {
        return HttpResponse.json({
          value: [{ innerHtml: '<p>Hello SharePoint</p>' }],
        });
      }

      if (method === 'GET' && /\/microsoft\.graph\.sitePage$/.test(pathname)) {
        return HttpResponse.json({
          id: 'page-1',
          title: 'Home',
          name: 'home.aspx',
          webUrl: 'https://contoso.sharepoint.com/sites/Marketing/SitePages/home.aspx',
          description: 'Home page',
          pageLayout: 'article',
          createdDateTime: '2026-01-01T10:00:00Z',
          lastModifiedDateTime: '2026-05-19T10:00:00Z',
        });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/columns$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            { id: 'col-1', name: 'Title', displayName: 'Title', readOnly: true, text: {} },
            {
              id: 'col-2',
              name: 'Status',
              displayName: 'Status',
              description: 'Current status',
              required: true,
              choice: { choices: ['Active', 'Complete'] },
            },
          ],
        });
      }

      if (method === 'POST' && /^\/v1\.0\/sites\/[^/]+\/lists$/.test(pathname)) {
        return HttpResponse.json(
          {
            id: 'list-new',
            displayName: 'Project Tracker',
            webUrl: 'https://contoso.sharepoint.com/sites/Marketing/Lists/ProjectTracker',
            list: { template: 'genericList', hidden: false },
          },
          { status: 201 },
        );
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/lists$/.test(pathname)) {
        return HttpResponse.json({ value: [listEntity] });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items$/.test(pathname)) {
        return HttpResponse.json({ value: [listItem] });
      }

      if (method === 'POST' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items$/.test(pathname)) {
        return HttpResponse.json({
          id: '2',
          webUrl: 'https://contoso.sharepoint.com/sites/Marketing/Lists/Tasks/2_.000',
          fields: { Title: 'Created' },
        });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return HttpResponse.json(listItem);
      }

      if (method === 'PATCH' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/[^/]+\/fields$/.test(pathname)) {
        return HttpResponse.json({ Title: 'Updated', Status: 'Complete' });
      }

      if (method === 'DELETE' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return new HttpResponse(null, { status: 204 });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+$/.test(pathname)) {
        return HttpResponse.json(listEntity);
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/sites$/.test(pathname)) {
        return HttpResponse.json({ value: [{ ...site, id: 'subsite-1', name: 'Subsite' }] });
      }

      if (method === 'GET' && pathname.includes('/getByPath(path=')) {
        return HttpResponse.json(site);
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/items$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            {
              id: 'site-item-1',
              name: 'Site Item',
              webUrl: 'https://contoso.sharepoint.com/sites/Marketing/item-1',
              contentType: { name: 'Item' },
              createdDateTime: '2026-01-01T10:00:00Z',
              lastModifiedDateTime: '2026-05-19T10:00:00Z',
            },
          ],
        });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return HttpResponse.json({
          id: 'site-item-1',
          name: 'Site Item',
          webUrl: 'https://contoso.sharepoint.com/sites/Marketing/item-1',
          contentType: { name: 'Item' },
          createdDateTime: '2026-01-01T10:00:00Z',
          lastModifiedDateTime: '2026-05-19T10:00:00Z',
          fields: { Title: 'Site Item' },
        });
      }

      if (method === 'POST' && pathname === '/v1.0/search/query') {
        return HttpResponse.json({
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      rank: 1,
                      summary: 'Match summary',
                      resource: {
                        id: 'res-1',
                        name: 'Document 1',
                        webUrl: 'https://contoso.sharepoint.com/doc1',
                        '@odata.type': '#microsoft.graph.driveItem',
                        parentReference: {
                          siteId: 'site-1',
                          driveId: 'drive-1',
                          path: '/drives/drive-1/root:',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        });
      }

      if (method === 'GET' && pathname === '/v1.0/me/drive/recent') {
        return HttpResponse.json({ value: [fileItem] });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/root\/children$/.test(pathname)) {
        return HttpResponse.json({ value: [folderItem, fileItem] });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/root:\/.*:\/children$/.test(pathname)) {
        return HttpResponse.json({ value: [fileItem] });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/root:\/.*:\/createUploadSession$/.test(pathname)) {
        return HttpResponse.json({
          uploadUrl: 'https://graph.microsoft.com/v1.0/drives/drive-1/uploadSessions/session-1',
          expirationDateTime: '2026-05-20T10:00:00Z',
        });
      }

      if (method === 'PUT' && /^\/v1\.0\/drives\/[^/]+\/uploadSessions\/[^/]+$/.test(pathname)) {
        const range = request.headers.get('content-range') ?? '';
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
        if (!match) {
          return HttpResponse.json({ error: { message: 'Missing or invalid Content-Range' } }, { status: 400 });
        }
        const end = Number(match[2]);
        const total = Number(match[3]);
        if (end + 1 < total) {
          return HttpResponse.json(
            { nextExpectedRanges: [`${end + 1}-`] },
            { status: 202 },
          );
        }
        return HttpResponse.json(
          {
            id: 'uploaded-bin-1',
            name: 'report.bin',
            size: total,
            webUrl: 'https://contoso.sharepoint.com/uploaded-bin-1',
          },
          { status: 201 },
        );
      }

      if (method === 'PUT' && /^\/v1\.0\/drives\/[^/]+\/root:\/.*:\/content$/.test(pathname)) {
        return HttpResponse.json({
          id: 'uploaded-1',
          name: 'uploaded.txt',
          size: 52,
          webUrl: 'https://contoso.sharepoint.com/uploaded-1',
        });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/root\/children$/.test(pathname)) {
        return HttpResponse.json({
          id: 'folder-new',
          name: 'New Folder',
          webUrl: 'https://contoso.sharepoint.com/folder-new',
        });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/root:\/.*:\/children$/.test(pathname)) {
        return HttpResponse.json({
          id: 'folder-new',
          name: 'New Folder',
          webUrl: 'https://contoso.sharepoint.com/folder-new',
        });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/root\/search\(q='.*'\)$/.test(pathname)) {
        return HttpResponse.json({ value: [fileItem] });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/content$/.test(pathname)) {
        return HttpResponse.text('Hello SharePoint text content');
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/children$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            {
              ...fileItem,
              id: 'nested-file-1',
              name: 'nested.txt',
              parentReference: { ...fileItem.parentReference, path: '/drives/drive-1/root:/General' },
            },
          ],
        });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/listItem\/fields$/.test(pathname)) {
        return HttpResponse.json({
          '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#sites(...)',
          Department: 'Marketing',
          Status: 'Approved',
        });
      }

      if (method === 'PATCH' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/listItem\/fields$/.test(pathname)) {
        return HttpResponse.json({
          Department: 'Marketing',
          Status: 'Updated',
        });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/copy$/.test(pathname)) {
        return new HttpResponse(null, {
          status: 202,
          headers: { Location: 'https://graph.microsoft.com/v1.0/monitor/copy-1' },
        });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/versions$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            {
              id: '1.0',
              size: 42,
              lastModifiedDateTime: '2026-05-18T10:00:00Z',
              lastModifiedBy: { user: { displayName: 'Alice Example' } },
            },
            {
              id: '2.0',
              size: 52,
              lastModifiedDateTime: '2026-05-19T10:00:00Z',
              lastModifiedBy: { user: { displayName: 'Bob Example' } },
            },
          ],
        });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/permissions$/.test(pathname)) {
        return HttpResponse.json({ value: [permission] });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/invite$/.test(pathname)) {
        return HttpResponse.json({
          value: [
            {
              id: 'perm-2',
              roles: ['read'],
              grantedToV2: { user: { displayName: 'Jane Example', email: 'jane@example.com' } },
            },
          ],
        });
      }

      if (method === 'DELETE' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/permissions\/[^/]+$/.test(pathname)) {
        return new HttpResponse(null, { status: 204 });
      }

      if (method === 'POST' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/createLink$/.test(pathname)) {
        return HttpResponse.json({
          id: 'perm-1',
          roles: ['read'],
          link: {
            webUrl: 'https://contoso.sharepoint.com/share/perm-1',
            type: 'view',
            scope: 'organization',
          },
        });
      }

      if (method === 'GET' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return HttpResponse.json(fileItem);
      }

      if (method === 'PATCH' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return HttpResponse.json({
          id: 'item-1',
          name: 'renamed.txt',
          webUrl: 'https://contoso.sharepoint.com/file/item-1',
        });
      }

      if (method === 'DELETE' && /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+$/.test(pathname)) {
        return new HttpResponse(null, { status: 204 });
      }

      if (method === 'GET' && /^\/v1\.0\/sites\/[^/]+$/.test(pathname)) {
        return HttpResponse.json(site);
      }

      return HttpResponse.json({});
    }),
  ];

  return { handlers, state };
}
