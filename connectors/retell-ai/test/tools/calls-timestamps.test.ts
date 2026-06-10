import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const RETELL_API_BASE = 'https://api.retellai.com';

/**
 * Collects the JSON-schema types a property node accepts. Handles both export
 * shapes zod-to-json-schema can produce for a union: `anyOf: [{type}, ...]`
 * and the collapsed primitive form `type: [...]`.
 */
function acceptedTypes(node: Record<string, unknown>): string[] {
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as Array<{ type?: string }>).map(o => o.type ?? '').filter(Boolean);
  }
  if (Array.isArray(node.type)) return node.type as string[];
  if (typeof node.type === 'string') return [node.type];
  return [];
}

describe('list_calls timestamp filters — epoch ms OR date string', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('exported schema advertises number AND string for both timestamp filters', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    const listCalls = toolsResult.tools.find(t => t.name === 'list_calls');
    expect(listCalls).toBeDefined();

    const filterCriteria = (listCalls!.inputSchema as {
      properties?: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
    }).properties?.filter_criteria;
    expect(filterCriteria?.properties).toBeDefined();

    for (const field of ['after_start_timestamp', 'before_start_timestamp']) {
      const node = filterCriteria!.properties![field];
      expect(node, `${field} should be in the exported schema`).toBeDefined();
      const types = acceptedTypes(node);
      // A strict host validates the EXPORTED schema before the connector runs;
      // both the numeric and string forms must be advertised.
      expect(
        types.some(t => t === 'number' || t === 'integer'),
        `${field} should accept a number (got types: ${JSON.stringify(types)})`,
      ).toBe(true);
      expect(
        types.includes('string'),
        `${field} should accept a string (got types: ${JSON.stringify(types)})`,
      ).toBe(true);
    }
  });

  it('coerces ISO date strings to epoch ms in the outgoing Retell request', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      // First in the list wins in MSW — must precede the default handlers.
      http.post(`${RETELL_API_BASE}/v3/list-calls`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json([]);
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_calls',
      arguments: {
        filter_criteria: {
          after_start_timestamp: '2026-01-01',
          before_start_timestamp: '2026-02-01T00:00:00Z',
        },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).ok).toBe(true);

    expect(capturedBody).not.toBeNull();
    const filter = capturedBody!.filter_criteria as Record<string, unknown>;
    expect(filter.after_start_timestamp).toBe(Date.parse('2026-01-01'));
    expect(filter.before_start_timestamp).toBe(Date.parse('2026-02-01T00:00:00Z'));
    expect(typeof filter.after_start_timestamp).toBe('number');
    expect(typeof filter.before_start_timestamp).toBe('number');
  });

  // Strings that must fail validation BEFORE the API is reached:
  // - 'not-a-date': un-parseable garbage.
  // - '1735689600': epoch SECONDS — forwarding it as ms would be 1000x wrong;
  //   digit-only strings outside the unambiguous epoch-ms window [1e12, 1e14)
  //   are rejected, not coerced.
  // - '1': tiny digit-only string — must never fall through to Date.parse
  //   (V8 would read "1" as year 2001).
  it.each(['not-a-date', '1735689600', '1'])(
    'rejects %j before reaching the API',
    async (badTimestamp) => {
      let apiCalled = false;
      mswServer.use(
        // First in the list wins in MSW — must precede the default handlers.
        http.post(`${RETELL_API_BASE}/v3/list-calls`, () => {
          apiCalled = true;
          return HttpResponse.json([]);
        }),
        ...createRetellHandlers(),
      );
      testClient = await createTestClient({
        env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      // Zod validation failure surfaces as a tool error result (or a protocol
      // error, depending on SDK version) — either way the API must not be hit.
      let isError = false;
      try {
        const result = await testClient.client.callTool({
          name: 'list_calls',
          arguments: { filter_criteria: { after_start_timestamp: badTimestamp } },
        });
        isError = result.isError === true;
      } catch {
        isError = true;
      }
      expect(isError).toBe(true);
      expect(apiCalled).toBe(false);
    },
  );

  it('accepts a 13-digit epoch-ms string and forwards it as a number', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      // First in the list wins in MSW — must precede the default handlers.
      http.post(`${RETELL_API_BASE}/v3/list-calls`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json([]);
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_calls',
      arguments: { filter_criteria: { after_start_timestamp: '1735689600000' } },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).ok).toBe(true);

    expect(capturedBody).not.toBeNull();
    const filter = capturedBody!.filter_criteria as Record<string, unknown>;
    expect(filter.after_start_timestamp).toBe(1735689600000);
    expect(typeof filter.after_start_timestamp).toBe('number');
  });

  it('passes plain epoch-ms numbers through unchanged', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      // First in the list wins in MSW — must precede the default handlers.
      http.post(`${RETELL_API_BASE}/v3/list-calls`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json([]);
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_calls',
      arguments: {
        filter_criteria: {
          after_start_timestamp: 1735689600000,
          before_start_timestamp: 1738368000000,
        },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).ok).toBe(true);

    expect(capturedBody).not.toBeNull();
    const filter = capturedBody!.filter_criteria as Record<string, unknown>;
    expect(filter.after_start_timestamp).toBe(1735689600000);
    expect(filter.before_start_timestamp).toBe(1738368000000);
  });
});
