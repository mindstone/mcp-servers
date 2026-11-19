/**
 * Every successful HubSpot reply is parsed against a schema before any field
 * is read. Malformed JSON and a shape mismatch both raise
 * HubSpotInvalidResponseError, which tools report as INVALID_RESPONSE, and
 * the diagnostics carry no vendor values, vendor-authored keys or Zod text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/hubspot-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api/hubspot-client.js')>();
  return { ...actual, getHubSpotClientAsync: vi.fn(async () => new actual.HubSpotClient('test-token')) };
});

const { HubSpotClient } = await import('../src/api/hubspot-client.js');
const { HubSpotInvalidResponseError } = await import('../src/api/response-parsing.js');
const { HubSpotOAuthClient } = await import('../src/modules/accounts/oauth.js');
const { parseHubSpotError } = await import('../src/utils/error-parser.js');
const { handleGetContact } = await import('../src/tools/crm-handlers.js');
const { handleGetFile } = await import('../src/tools/file-handlers.js');
const { checkSalesEmailReadScope } = await import('../src/tools/sales-email-scope.js');
const { handleListKbArticles, handleGetKbArticle } = await import('../src/tools/knowledge-base-handlers.js');

type Reply = { status?: number; body: string | null };

/** Answer each fetch in turn with the next reply; record every request. */
function stubFetch(...replies: Reply[]): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: reply.body === null ? {} : { 'content-type': 'application/json' },
    });
  }));
  return calls;
}

const json = (value: unknown): Reply => ({ body: JSON.stringify(value) });
const NOT_JSON: Reply = { body: '<html>gateway hiccup</html>' };
const NO_CONTENT: Reply = { status: 204, body: null };
/** The fields HubSpot documents as always present on a File. */
const FILE = {
  id: 'f-1',
  access: 'PRIVATE',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('expected a rejection'); },
    (error: unknown) => error,
  );
}

function toolErrorOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(Error);
  return JSON.parse((error as Error).message) as Record<string, unknown>;
}

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.stubEnv('HUBSPOT_CLIENT_ID', 'test-client-id');
  vi.stubEnv('HUBSPOT_CLIENT_SECRET', 'test-client-secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const client = new HubSpotClient('test-token');

describe('request replies', () => {
  it('rejects malformed JSON with the typed error', async () => {
    stubFetch(NOT_JSON);
    const error = await rejection(client.getObject('contacts', '1'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({
      code: 'INVALID_RESPONSE',
      reason: 'malformed_json',
      operation: 'GET crm_object',
      issueCount: 0,
    });
    expect(parseHubSpotError(error, { operation: 'get' })).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });

  it('rejects a reply missing a required field with a schema-owned path', async () => {
    stubFetch(json({ id: '1' }));
    const error = await rejection(client.getObject('contacts', '1'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({
      reason: 'schema_mismatch',
      issueCount: 1,
      issues: [{ code: 'invalid_type', path: 'properties' }],
    });
  });

  it('accepts a schema-valid reply and keeps unknown fields', async () => {
    stubFetch(json({ id: '1', properties: { email: 'jane@example.com', phone: null }, extra: 'kept' }));
    await expect(client.getObject('contacts', '1')).resolves.toMatchObject({
      id: '1',
      properties: { email: 'jane@example.com', phone: null },
      extra: 'kept',
    });
  });

  it('reports INVALID_RESPONSE from a tool handler', async () => {
    stubFetch(NOT_JSON);
    const error = await rejection(handleGetContact({ contactId: '1' }));
    expect(toolErrorOf(error)).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });
});

describe('bodiless replies', () => {
  it('accepts 204 for a method that returns nothing', async () => {
    const calls = stubFetch(NO_CONTENT);
    await expect(client.deleteFile('f-1')).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
  });

  it('rejects 204 for a method that returns an object', async () => {
    stubFetch(NO_CONTENT);
    const error = await rejection(client.getFile('f-1'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({ reason: 'schema_mismatch', issues: [{ code: 'invalid_type', path: '(root)' }] });
  });

  it('rejects an empty 200 body for a method that returns an object', async () => {
    stubFetch({ body: '' });
    await expect(client.getOwner('o-1')).rejects.toBeInstanceOf(HubSpotInvalidResponseError);
  });
});

describe('list replies', () => {
  it('rejects a reply with neither lists nor results', async () => {
    stubFetch(json({}));
    const error = await rejection(client.listLists());
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({ reason: 'schema_mismatch', operation: 'GET lists' });
  });

  it.each([
    ['lists', { lists: [] }],
    ['results', { results: [] }],
  ])('accepts an empty %s reply as an empty list', async (_form, reply) => {
    stubFetch(json(reply));
    await expect(client.listLists()).resolves.toEqual({ results: [], paging: undefined });
  });

  it('normalises a lists reply to results', async () => {
    stubFetch(json({ lists: [{ listId: 'l-1', name: 'Newsletter' }], paging: { next: { after: '2' } } }));
    await expect(client.listLists()).resolves.toEqual({
      results: [{ listId: 'l-1', name: 'Newsletter' }],
      paging: { next: { after: '2' } },
    });
  });
});

describe('file import status', () => {
  it('rejects COMPLETE without a result', async () => {
    stubFetch(json({ status: 'COMPLETE' }));
    const error = await rejection(client.getImportStatus('t-1'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({ issues: [{ code: 'invalid_type', path: 'result' }] });
  });

  it('accepts a pending status without a result', async () => {
    stubFetch(json({ status: 'PENDING' }));
    await expect(client.getImportStatus('t-1')).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('rejects an unknown status', async () => {
    stubFetch(json({ status: 'SOMETHING_ELSE' }));
    await expect(client.getImportStatus('t-1')).rejects.toBeInstanceOf(HubSpotInvalidResponseError);
  });
});

describe('upload replies', () => {
  const upload = () => client.uploadFile(Buffer.from('hello'), 'hello.txt', { access: 'PRIVATE' });

  it('accepts a reply with only the documented always-present fields', async () => {
    const calls = stubFetch(json(FILE));
    await expect(upload()).resolves.toEqual(FILE);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.hubapi.com/files/v3/files' });
  });

  it('rejects malformed JSON with the typed error', async () => {
    stubFetch(NOT_JSON);
    const error = await rejection(upload());
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({ reason: 'malformed_json', operation: 'POST file_upload' });
    expect(parseHubSpotError(error, { operation: 'upload_file' })).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });

  it('rejects a reply without access', async () => {
    const { access: _access, ...withoutAccess } = FILE;
    stubFetch(json({ ...withoutAccess, name: 'hello.txt' }));
    const error = await rejection(upload());
    expect(error).toMatchObject({ reason: 'schema_mismatch', issues: [{ code: 'invalid_type', path: 'access' }] });
  });

  it('rejects a reply with a non-boolean archived', async () => {
    stubFetch(json({ ...FILE, archived: 'not-a-boolean' }));
    const error = await rejection(upload());
    expect(error).toMatchObject({ reason: 'schema_mismatch', issues: [{ code: 'invalid_type', path: 'archived' }] });
  });

  it('rejects a reply without archived, createdAt and updatedAt', async () => {
    stubFetch(json({ id: 'f-1', access: 'PRIVATE' }));
    const error = await rejection(upload());
    expect(error).toMatchObject({ reason: 'schema_mismatch', issueCount: 3 });
    expect((error as InstanceType<typeof HubSpotInvalidResponseError>).issues.map((issue) => issue.path).sort())
      .toEqual(['archived', 'createdAt', 'updatedAt']);
  });

  it('keeps the HubSpotApiError path for a failed upload', async () => {
    stubFetch({ status: 500, body: JSON.stringify({ message: 'boom' }) });
    await expect(upload()).rejects.toMatchObject({ name: 'HubSpotApiError', statusCode: 500 });
  });
});

describe('token-info replies', () => {
  it('parses the OAuth token-info reply', async () => {
    stubFetch(json({ hub_id: 42, user: 'jane@example.com', scopes: ['crm.objects.contacts.read'] }));
    await expect(new HubSpotOAuthClient().getTokenInfo('access-token')).resolves.toEqual({
      hub_id: 42,
      user: 'jane@example.com',
      scopes: ['crm.objects.contacts.read'],
    });
  });

  it('rejects malformed JSON from the OAuth token-info call', async () => {
    stubFetch(NOT_JSON);
    const error = await rejection(new HubSpotOAuthClient().getTokenInfo('access-token'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect(error).toMatchObject({ reason: 'malformed_json', operation: 'GET token_info' });
    expect(parseHubSpotError(error, { operation: 'token_info' })).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });

  it('rejects a token-info reply without hub_id', async () => {
    stubFetch(json({ user: 'jane@example.com', scopes: [] }));
    const error = await rejection(new HubSpotOAuthClient().getTokenInfo('access-token'));
    expect(error).toMatchObject({ reason: 'schema_mismatch', issues: [{ code: 'invalid_type', path: 'hub_id' }] });
  });

  it('rejects a client token-info reply with the wrong scopes type', async () => {
    stubFetch(json({ hub_id: 42, scopes: 'crm.objects.contacts.read' }));
    const error = await rejection(client.getTokenInfo());
    expect(error).toMatchObject({ reason: 'schema_mismatch', issues: [{ code: 'invalid_type', path: 'scopes' }] });
  });

  it('keeps the classification when the scope check degrades', async () => {
    stubFetch(NOT_JSON);
    const scopeClient = new HubSpotClient('scope-check-token');
    await expect(checkSalesEmailReadScope(async () => scopeClient)).resolves.toBeUndefined();
    expect(logged.some((line) => line.includes('hubspot_sales_email_scope_check_failed')
      && line.includes('"errorCode":"INVALID_RESPONSE"'))).toBe(true);
  });
});

describe('diagnostics never carry vendor data', () => {
  const MARKER = 'zq7MARKERzq7';

  it('keeps a marker in a record key and a value out of the error, the logs and the tool error', async () => {
    stubFetch(json({
      id: '1',
      properties: { [`${MARKER}_key`]: { nested: `${MARKER}_value` } },
      [`${MARKER}_extra`]: `${MARKER}_extra_value`,
    }));

    const toolError = await rejection(handleGetContact({ contactId: '1' }));
    expect(toolErrorOf(toolError)).toMatchObject({ errorCode: 'INVALID_RESPONSE' });

    stubFetch(json({ id: '1', properties: { [`${MARKER}_key`]: { nested: `${MARKER}_value` } } }));
    const error = await rejection(client.getObject('contacts', '1'));
    expect(error).toMatchObject({
      reason: 'schema_mismatch',
      issues: [{ code: 'invalid_type', path: 'properties.<key>' }],
    });

    const surfaces = [
      (error as Error).message,
      JSON.stringify(error),
      JSON.stringify((error as { issues: unknown }).issues),
      (toolError as Error).message,
      ...logged,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(MARKER);
      // Zod's own messages quote received types and values; none are kept.
      expect(surface).not.toMatch(/Expected string, received/);
    }
    expect(logged.some((line) => line.includes('hubspot_invalid_response'))).toBe(true);
  });
});

describe('signed URL degradation', () => {
  it('keeps INVALID_RESPONSE when the signed-URL reply is malformed', async () => {
    const calls = stubFetch(json({ ...FILE, name: 'report.pdf' }), NOT_JSON);
    const result = await handleGetFile({ fileId: 'f-1', getSignedUrl: true });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/files/v3/files/f-1',
      '/files/v3/files/f-1/signed-url',
    ]);
    expect(result).toMatchObject({ signedUrl: null, signedUrlErrorCode: 'INVALID_RESPONSE' });
    expect(logged.some((line) => line.includes('hubspot_signed_url_failed')
      && line.includes('"errorCode":"INVALID_RESPONSE"'))).toBe(true);
  });
});

describe('knowledge-base GraphQL replies', () => {
  const article = {
    hs_id: 'kb-1', hs_name: 'Getting started', hs_body: null, hs_path: '/getting-started',
    hs_slug: 'getting-started', hs_language: 'en', hs_meta_description: null,
  };

  it.each([
    ['an empty envelope', {}],
    ['empty data', { data: {} }],
    ['null data', { data: null }],
    ['an empty errors list', { errors: [] }],
    ['a collection without its fields', { data: { KB: { knowledge_article_collection: {} } } }],
    ['an article missing a selected field', {
      data: { KB: { knowledge_article_collection: { total: 1, items: [{ hs_id: 'kb-1' }] } } },
    }],
  ])('reports INVALID_RESPONSE for %s when listing', async (_name, body) => {
    stubFetch(json(body));
    const error = await rejection(handleListKbArticles({}));
    expect(toolErrorOf(error)).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });

  it('reports INVALID_RESPONSE for a reply without the article key', async () => {
    stubFetch(json({ data: { KB: {} } }));
    const error = await rejection(handleGetKbArticle({ articleId: 'kb-1' }));
    expect(toolErrorOf(error)).toMatchObject({ errorCode: 'INVALID_RESPONSE' });
  });

  it('returns an empty list for a valid empty collection', async () => {
    stubFetch(json({ data: { KB: { knowledge_article_collection: { total: 0, items: [] } } } }));
    await expect(handleListKbArticles({})).resolves.toMatchObject({ articles: [], total: 0 });
  });

  it('lists a valid collection', async () => {
    stubFetch(json({ data: { KB: { knowledge_article_collection: { total: 1, items: [article] } } } }));
    const result = await handleListKbArticles({});
    expect(result.total).toBe(1);
    expect(result.articles).toHaveLength(1);
  });

  it('keeps the GraphQL error classification for an error reply with partial data', async () => {
    stubFetch(json({
      data: { KB: null },
      errors: [{ message: 'Cannot query field "KB" on type "Query"' }],
    }));
    const error = await rejection(handleListKbArticles({}));
    expect(toolErrorOf(error)).toMatchObject({ errorCode: 'SERVICE_HUB_REQUIRED' });
  });

  it('treats a null article as not found, not as a malformed reply', async () => {
    stubFetch(json({ data: { KB: { knowledge_article: null } } }));
    const error = await rejection(handleGetKbArticle({ articleId: 'kb-404' }));
    expect(toolErrorOf(error).errorCode).not.toBe('INVALID_RESPONSE');
  });

  it.each([
    ['an error reply', {
      data: { zq7MARKERzq7: true, KB: { zq8MARKERzq8: true } },
      errors: [{ message: 'Missing required scope' }],
    }],
    ['a data reply', {
      data: { zq7MARKERzq7: true, KB: { zq8MARKERzq8: true, knowledge_article_collection: { total: 0, items: [] } } },
    }],
  ])('does not log vendor-authored keys from %s', async (_name, body) => {
    const { default: logger } = await import('../src/utils/logger.js');
    const spies = (['debug', 'info', 'warn', 'error'] as const)
      .map((level) => vi.spyOn(logger, level).mockImplementation(() => undefined));
    stubFetch(json(body));
    await handleListKbArticles({}).catch(() => undefined);
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain('MARKER');
  });
});

describe('email statistics replies', () => {
  it('accepts the documented aggregate, campaign aggregations and email IDs', async () => {
    const aggregate = { counters: { sent: 10, open: 4 }, ratios: { openratio: 40 } };
    stubFetch(json({ aggregate, campaignAggregations: { 'c-1': aggregate }, emails: [101, 102] }));
    await expect(client.getEmailStatistics('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'))
      .resolves.toMatchObject({ aggregate, emails: [101, 102] });
  });

  it('rejects a non-object aggregate and non-numeric email entries', async () => {
    stubFetch(json({ aggregate: 'not-an-object', emails: [{}] }));
    const error = await rejection(client.getEmailStatistics('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect((error as InstanceType<typeof HubSpotInvalidResponseError>).issues.map((issue) => issue.path).sort())
      .toEqual(['aggregate', 'emails[0]']);
  });
});

describe('conversation original content replies', () => {
  it('accepts text and rich text strings', async () => {
    stubFetch(json({ text: 'Hello', richText: '<p>Hello</p>' }));
    await expect(client.getConversationThreadMessageOriginalContent('t-1', 'm-1'))
      .resolves.toMatchObject({ text: 'Hello', richText: '<p>Hello</p>' });
  });

  it('rejects text and rich text that are not strings', async () => {
    stubFetch(json({ text: 123, richText: [] }));
    const error = await rejection(client.getConversationThreadMessageOriginalContent('t-1', 'm-1'));
    expect(error).toBeInstanceOf(HubSpotInvalidResponseError);
    expect((error as InstanceType<typeof HubSpotInvalidResponseError>).issues.map((issue) => issue.path).sort())
      .toEqual(['richText', 'text']);
  });
});

describe('owner replies', () => {
  it('accepts an archived owner whose userId is null', async () => {
    stubFetch(json({
      id: 'o-1', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe',
      userId: null, archived: true,
    }));
    await expect(client.getOwner('o-1')).resolves.toMatchObject({ id: 'o-1', userId: null });
  });
});

describe('workflow enrollment replies', () => {
  it.each([
    ['a 204', NO_CONTENT],
    ['an empty 200', { body: '' }],
  ])('treats %s as an acknowledgement', async (_name, reply) => {
    stubFetch(reply);
    await expect(client.enrollInWorkflow('flow-1', ['1'])).resolves.toEqual({});
  });

  it('passes a JSON object through', async () => {
    stubFetch(json({ status: 'ok' }));
    await expect(client.enrollInWorkflow('flow-1', ['1'])).resolves.toEqual({ status: 'ok' });
  });

  it.each([['a string', 'enrolled'], ['a number', 1], ['null', null]])(
    'rejects %s as the reply',
    async (_name, body) => {
      stubFetch(json(body));
      await expect(client.enrollInWorkflow('flow-1', ['1'])).rejects.toBeInstanceOf(HubSpotInvalidResponseError);
    },
  );
});
