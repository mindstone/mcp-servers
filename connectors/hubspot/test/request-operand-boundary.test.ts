/**
 * Values placed in a request path or GraphQL text stay data: they cannot change
 * which endpoint or record a request reaches. Checked at the request actually
 * sent (the fetch URL and the GraphQL body), for crafted and normal values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The KB handlers get a real client, so their GraphQL text is read from the fetch body.
vi.mock('../src/api/hubspot-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api/hubspot-client.js')>();
  return { ...actual, getHubSpotClientAsync: vi.fn(async () => new actual.HubSpotClient('test-token')) };
});

const { HubSpotClient, pathSegment } = await import('../src/api/hubspot-client.js');
const { handleGetKbArticle, handleListKbArticles } = await import('../src/tools/knowledge-base-handlers.js');

function captureFetch(reply: unknown = {}): Array<{ url: string; method: string; body?: string }> {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

/** The GraphQL text in the request body actually sent. */
const sentQuery = (calls: Array<{ body?: string }>): string => JSON.parse(calls[0].body!).query;

/** The path the server would see, after URL parsing resolves any dot segments. */
const sentPath = (url: string) => new URL(url).pathname;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pathSegment', () => {
  it.each(['', '.', '..'])('refuses %j, which URL parsing treats as a directory step', value => {
    expect(() => pathSegment(value)).toThrow(/INVALID_ARGUMENTS/);
  });

  it('encodes delimiters so the value stays one segment', () => {
    expect(pathSegment('1/../../owners?x=1#f')).toBe('1%2F..%2F..%2Fowners%3Fx%3D1%23f');
    expect(pathSegment(42)).toBe('42');
  });
});

describe('HubSpot client request paths', () => {
  const client = new HubSpotClient('test-token');

  // Every method that used to interpolate a raw value into its path.
  const cases: Array<[string, (value: string) => Promise<unknown>, (value: string) => string]> = [
    ['getOwner', v => client.getOwner(v), v => `/crm/v3/owners/${v}`],
    ['listPipelines', v => client.listPipelines(v), v => `/crm/v3/pipelines/${v}`],
    ['getPipeline', v => client.getPipeline('deals', v), v => `/crm/v3/pipelines/deals/${v}`],
    ['getForm', v => client.getForm(v), v => `/marketing/v3/forms/${v}`],
    ['getFormSubmissions', v => client.getFormSubmissions(v), v => `/form-integrations/v1/submissions/forms/${v}`],
    ['getAnalyticsReport', v => client.getAnalyticsReport(v, 'total', '20260101', '20260102'), v => `/analytics/v2/reports/${v}/total`],
    ['getMarketingEmail', v => client.getMarketingEmail(v), v => `/marketing/v3/emails/${v}`],
    ['getList', v => client.getList(v), v => `/crm/v3/lists/${v}`],
    ['getListMembers', v => client.getListMembers(v), v => `/crm/v3/lists/${v}/memberships`],
    ['getImportStatus', v => client.getImportStatus(v), v => `/files/v3/files/import-from-url/async/tasks/${v}/status`],
    ['getFile', v => client.getFile(v), v => `/files/v3/files/${v}`],
    ['getFileSignedUrl', v => client.getFileSignedUrl(v), v => `/files/v3/files/${v}/signed-url`],
    ['deleteFile', v => client.deleteFile(v), v => `/files/v3/files/${v}`],
  ];

  it.each(cases)('%s keeps a normal ID as is', async (_name, call, expected) => {
    const calls = captureFetch();
    await call('123456');
    expect(sentPath(calls[0].url)).toBe(expected('123456'));
  });

  it.each(cases)('%s keeps a crafted ID inside its own segment', async (_name, call, expected) => {
    const calls = captureFetch();
    await call('1/../../../crm/v3/objects/contacts/9?archived=true#x');
    expect(sentPath(calls[0].url)).toBe(
      expected('1%2F..%2F..%2F..%2Fcrm%2Fv3%2Fobjects%2Fcontacts%2F9%3Farchived%3Dtrue%23x')
    );
    expect(new URL(calls[0].url).search).not.toContain('archived');
  });

  it.each(cases)('%s refuses a dot-segment ID before any request', async (_name, call) => {
    const calls = captureFetch();
    await expect(call('..')).rejects.toThrow(/INVALID_ARGUMENTS/);
    expect(calls).toHaveLength(0);
  });

  it('getEngagement keeps properties inside the one properties parameter', async () => {
    const calls = captureFetch();
    await client.getEngagement('calls', '123', ['hs_call_title&archived=true', 'idProperty=other']);
    const sent = new URL(calls[0].url);
    expect(sent.pathname).toBe('/crm/v3/objects/calls/123');
    expect([...sent.searchParams.keys()]).toEqual(['properties']);
    expect(sent.searchParams.get('properties')).toBe('hs_call_title&archived=true,idProperty=other');
  });

  it('getEngagement sends normal properties as before', async () => {
    const calls = captureFetch();
    await client.getEngagement('calls', '123', ['hs_call_title', 'hs_call_body']);
    expect(new URL(calls[0].url).search).toBe('?properties=hs_call_title%2Chs_call_body');
  });

  it('deleteFile sends DELETE only to the named file', async () => {
    const calls = captureFetch();
    await expect(client.deleteFile('%2E%2E')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    expect(sentPath(calls[0].url)).toBe('/files/v3/files/%252E%252E');
  });
});

describe('HubSpot knowledge-base GraphQL text', () => {
  const okArticle = { data: { KB: { knowledge_article: { hs_id: 'kb-1' } } } };

  it.each([
    'kb-1',
    'say "hi"',
    'ends in a backslash\\',
    'two\nlines',
    '") { secret } x: knowledge_article(uniqueIdentifierValue: "',
  ])('keeps article ID %j as one string value', async articleId => {
    const calls = captureFetch(okArticle);
    await handleGetKbArticle({ articleId });
    const query = sentQuery(calls);
    const literal = query.match(/uniqueIdentifierValue: (".*?(?<!\\)(?:\\\\)*")\)/s)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal!)).toBe(articleId);
  });

  it('writes normal limit and offset as numbers', async () => {
    const calls = captureFetch({ data: { KB: { knowledge_article_collection: { total: 0, items: [] } } } });
    await handleListKbArticles({ limit: 5, offset: 10 });
    expect(sentQuery(calls)).toContain('knowledge_article_collection(limit: 5, offset: 10)');
  });

  it.each([
    { limit: '1) { secret } x: knowledge_article_collection(limit: 1' },
    { offset: -1 },
    { limit: 1.5 },
  ])('refuses limit/offset %j without querying', async args => {
    const calls = captureFetch();
    await expect(
      handleListKbArticles(args as unknown as Parameters<typeof handleListKbArticles>[0])
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
