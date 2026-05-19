import { describe, expect, it, vi } from 'vitest';
import type { Client, ToolResult } from '@mindstone/mcp-server-microsoft-shared';
import { readSitePage } from '../src/sharepoint.js';

function parseResult(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

function makeClient(webPartsBehavior: 'ok' | 'unsupported' | 'error'): Client {
  return {
    api: vi.fn((endpoint: string) => {
      const builder = {
        options: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        get: vi.fn(async () => {
          if (endpoint.endsWith('/webParts')) {
            if (webPartsBehavior === 'ok') {
              return { value: [{ innerHtml: '<p>Hello SharePoint</p>' }] };
            }
            const err = new Error(
              webPartsBehavior === 'unsupported' ? 'Webparts not supported on this page type' : 'Internal server error',
            ) as Error & { statusCode?: number };
            err.statusCode = webPartsBehavior === 'unsupported' ? 404 : 503;
            throw err;
          }

          return {
            id: 'page-1',
            title: 'Quarterly Report',
            name: 'QuarterlyReport',
            webUrl: 'https://contoso.sharepoint.com/sites/site-1/SitePages/page.aspx',
            description: 'Report page',
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-02T00:00:00Z',
            pageLayout: 'article',
          };
        }),
      };
      return builder;
    }),
  } as unknown as Client;
}

describe('readSitePage webparts fallback behavior', () => {
  it('returns success with contentWarning for unsupported page types', async () => {
    const result = await readSitePage(
      makeClient('unsupported'),
      { siteId: 'site-1', pageId: 'page-1' },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    const json = parseResult(result);
    expect(json.contentWarning).toContain('webparts could not be retrieved');
    expect(json.contentHtml).toContain('no text content found');
  });

  it('throws for unexpected webparts endpoint failures (fail closed)', async () => {
    await expect(
      readSitePage(
        makeClient('error'),
        { siteId: 'site-1', pageId: 'page-1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Internal server error/);
  });
});
