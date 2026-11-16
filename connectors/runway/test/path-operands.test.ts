/**
 * Task and voice IDs stay data in the request path: a crafted ID cannot point
 * a status check, cancel or delete at another endpoint. Checked at the request
 * actually sent, for crafted and normal IDs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';
import { pathSegment } from '../src/utils.js';

const BASE = 'https://api.dev.runwayml.com/v1';

describe('Runway request path operands', () => {
  let testClient: McpTestClient;
  let sent: Array<{ method: string; path: string }>;

  async function start(): Promise<void> {
    sent = [];
    mswServer.use(
      http.all(`${BASE}/*`, ({ request }) => {
        // The raw path as sent; URL parsing has already resolved any dot segments.
        sent.push({ method: request.method, path: new URL(request.url).pathname });
        if (request.method === 'DELETE') return new HttpResponse(null, { status: 204 });
        return HttpResponse.json({ id: 'task-1', status: 'SUCCEEDED', createdAt: '2026-01-01T00:00:00Z', output: [] });
      }),
    );
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const crafted = '1/../../organization?x=1#f';
  const encoded = '1%2F..%2F..%2Forganization%3Fx%3D1%23f';

  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['check_runway_task', { task_id: 'ID' }, 'GET', '/v1/tasks/ID'],
    ['wait_for_runway_task', { task_id: 'ID' }, 'GET', '/v1/tasks/ID'],
    ['cancel_runway_task', { task_id: 'ID' }, 'DELETE', '/v1/tasks/ID'],
    ['delete_custom_voice', { voice_id: 'ID' }, 'DELETE', '/v1/voices/ID'],
  ];
  const withId = (args: Record<string, unknown>, id: string) =>
    Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === 'ID' ? id : v]));

  it.each(cases)('%s sends a normal ID as is', async (tool, args, method, path) => {
    await start();
    await testClient.callTool(tool, withId(args, 'abc-123'));
    expect(sent[0]).toEqual({ method, path: path.replace('ID', 'abc-123') });
  });

  it.each(cases)('%s keeps a crafted ID inside its own segment', async (tool, args, method, path) => {
    await start();
    await testClient.callTool(tool, withId(args, crafted));
    expect(sent[0]).toEqual({ method, path: path.replace('ID', encoded) });
  });

  it.each(cases)('%s refuses a dot-segment ID before any request', async (tool, args) => {
    await start();
    const result = await testClient.callTool(tool, withId(args, '..'));
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('pathSegment refuses empty and dot segments', () => {
    for (const value of ['', '.', '..']) expect(() => pathSegment(value)).toThrow(/Invalid ID/);
  });
});
