import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers, createFathomUnauthorizedHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';
const BASE = 'https://api.fathom.ai/external/v1';

describe('Fathom action items', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { key?: string }) {
    mswServer.use(...createFathomHandlers(opts?.key ?? API_KEY));
    testClient = await createTestClient({
      env: {
        FATHOM_API_KEY: opts?.key ?? API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('get_fathom_meeting includes action items with enveloped descriptions', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_meeting', { recording_id: 101 });
    const json = result.json as {
      ok: boolean;
      meeting: {
        action_items: Array<{
          description: string;
          completed: boolean;
          assignee: { name: string; email: string };
        }> | null;
      };
    };

    expect(json.ok).toBe(true);
    expect(json.meeting.action_items).toHaveLength(2);
    expect(json.meeting.action_items?.[0].description).toBe(
      '<untrusted-content source="fathom:meeting:action_item">Send the updated proposal to the client</untrusted-content>',
    );
    expect(json.meeting.action_items?.[0].completed).toBe(false);
  });

  it('get_fathom_action_items returns only open items by default', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_action_items', {});
    const json = result.json as {
      ok: boolean;
      action_items: Array<{
        description: string;
        completed: boolean;
        meeting: { recording_id: number; title: string };
      }>;
      count: number;
      meetingsScanned: number;
      hasMore: boolean;
    };

    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(json.action_items[0].completed).toBe(false);
    expect(json.action_items[0].description).toContain('Send the updated proposal');
    expect(json.action_items[0].description).toContain('<untrusted-content');
    expect(json.action_items[0].meeting.recording_id).toBe(101);
    expect(json.meetingsScanned).toBe(2);
    expect(json.hasMore).toBe(false);
  });

  it('get_fathom_action_items include_completed=true returns all items', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_action_items', { include_completed: true });
    const json = result.json as {
      ok: boolean;
      action_items: Array<{ completed: boolean }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    expect(json.action_items.map((i) => i.completed)).toEqual([false, true]);
  });

  it('get_fathom_action_items passes server-side filters as query params', async () => {
    let capturedUrl = '';
    mswServer.use(
      http.get(`${BASE}/meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ limit: 25, next_cursor: null, items: [] });
      }),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('get_fathom_action_items', {
      teams: ['Sales'],
      created_after: '2026-01-01',
      meeting_type: 'external',
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get('include_action_items')).toBe('true');
    expect(url.searchParams.get('teams[]')).toBe('Sales');
    expect(url.searchParams.get('created_after')).toBe('2026-01-01');
    expect(url.searchParams.get('meeting_type')).toBe('external');
  });

  it('get_fathom_action_items honours the limit parameter', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_action_items', {
      include_completed: true,
      limit: 1,
    });
    const json = result.json as { ok: boolean; count: number; hasMore: boolean };

    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(json.hasMore).toBe(true);
  });

  it('get_fathom_action_items returns not-configured error when no API key is set', async () => {
    mswServer.use(...createFathomHandlers());
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_fathom_action_items', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('get_fathom_action_items surfaces auth failure without leaking the key', async () => {
    mswServer.use(...createFathomUnauthorizedHandlers());
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: 'secret-bad-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_fathom_action_items', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.code).toBe('AUTH_FAILED');
    expect(result.text).not.toContain('secret-bad-key-12345');
  });

  it('rejects a malformed limit before making any API request', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/*`, () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_fathom_action_items', { limit: 0 });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('list_fathom_meetings only returns action_items when requested', async () => {
    await setup();

    const withoutItems = await testClient.callTool('list_fathom_meetings', {});
    const jsonWithout = withoutItems.json as {
      meetings: Array<{ action_items?: unknown }>;
    };
    expect(jsonWithout.meetings[0].action_items).toBeUndefined();

    const withItems = await testClient.callTool('list_fathom_meetings', { include_action_items: true });
    const jsonWith = withItems.json as {
      meetings: Array<{ action_items?: Array<{ description: string }> }>;
    };
    expect(jsonWith.meetings[0].action_items).toHaveLength(2);
    expect(jsonWith.meetings[0].action_items?.[0].description).toContain('<untrusted-content');
  });
});
