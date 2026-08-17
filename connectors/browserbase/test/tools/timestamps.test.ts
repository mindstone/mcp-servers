import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

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

/** Tools and their epoch-ms date-filter fields (CONTRIBUTING.md contract). */
const EPOCH_MS_FIELDS: Array<{ tool: string; fields: string[] }> = [
  { tool: 'list_agents', fields: ['start_at', 'end_at'] },
  { tool: 'list_agent_runs', fields: ['start_at', 'end_at'] },
  { tool: 'list_downloads', fields: ['created_after', 'created_before'] },
];

describe('epoch-ms date filters — exported schema accepts number AND string', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('advertises number and string for every date filter', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const toolsResult = await testClient.client.listTools();
    for (const { tool, fields } of EPOCH_MS_FIELDS) {
      const toolDef = toolsResult.tools.find(t => t.name === tool);
      expect(toolDef, `${tool} should be registered`).toBeDefined();
      const properties = (toolDef!.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }).properties;

      for (const field of fields) {
        const node = properties?.[field];
        expect(node, `${tool}.${field} should be in the exported schema`).toBeDefined();
        const types = acceptedTypes(node!);
        // A strict host validates the EXPORTED schema before the connector runs;
        // both the numeric and string forms must be advertised.
        expect(
          types.some(t => t === 'number' || t === 'integer'),
          `${tool}.${field} should accept a number (got types: ${JSON.stringify(types)})`,
        ).toBe(true);
        expect(
          types.includes('string'),
          `${tool}.${field} should accept a string (got types: ${JSON.stringify(types)})`,
        ).toBe(true);
        // Every date field must state the accepted forms in its description.
        expect(String(node!.description)).toContain('milliseconds');
      }
    }
  });

  it('accepts epoch-ms numbers and date strings at runtime; rejects ambiguous input', async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const asNumber = await testClient.callTool('list_downloads', {
      session_id: 'any', created_after: 1735689600000,
    });
    expect(asNumber.isError).toBeFalsy();

    const asIso = await testClient.callTool('list_downloads', {
      session_id: 'any', created_after: '2026-01-01T00:00:00Z',
    });
    expect(asIso.isError).toBeFalsy();

    const asEpochString = await testClient.callTool('list_downloads', {
      session_id: 'any', created_after: '1735689600000',
    });
    expect(asEpochString.isError).toBeFalsy();

    // Unix SECONDS would silently be 1000x off — must be rejected, not coerced.
    const ambiguous = await testClient.callTool('list_downloads', {
      session_id: 'any', created_after: '1735689600',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('epoch milliseconds');

    const garbage = await testClient.callTool('list_downloads', {
      session_id: 'any', created_after: 'not-a-date',
    });
    expect(garbage.isError).toBe(true);
  });
});
