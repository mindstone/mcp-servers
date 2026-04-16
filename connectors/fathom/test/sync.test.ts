import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createFathomHandlers,
  createFathomUnauthorizedHandlers,
} from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { mockMeetings } from './fixtures/fathom-data.js';

const API_KEY = 'test-fathom-key';

describe('sync_fathom_meetings_to_rebel', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { key?: string; bridgeStatePath?: string }) {
    mswServer.use(...createFathomHandlers(opts?.key ?? API_KEY));
    testClient = await createTestClient({
      env: {
        FATHOM_API_KEY: opts?.key ?? API_KEY,
        MCP_HOST_BRIDGE_STATE: opts?.bridgeStatePath ?? '',
      },
    });
  }

  // --- sync-001: dry_run returns meeting list without sending to Rebel ---
  it('dry_run returns list of meetings that would be synced', async () => {
    await setup();
    const result = await testClient.callTool('sync_fathom_meetings_to_rebel', {
      dry_run: true,
    });
    const json = result.json as {
      ok: boolean;
      dry_run: boolean;
      would_sync: number;
      meetings: Array<{ recording_id: number; title: string }>;
      message: string;
    };
    expect(json.ok).toBe(true);
    expect(json.dry_run).toBe(true);
    expect(json.would_sync).toBe(mockMeetings.length);
    expect(json.meetings).toHaveLength(mockMeetings.length);
    expect(json.meetings[0].recording_id).toBe(101);
    expect(json.meetings[0].title).toBe('Weekly Standup');
    expect(json.message).toContain('dry_run=false');
  });

  // --- sync-002: without bridge, returns ok with bridge_available=false ---
  it('syncs meetings without bridge — returns ok with bridge_available=false', async () => {
    await setup();
    const result = await testClient.callTool('sync_fathom_meetings_to_rebel', {
      dry_run: false,
    });
    const json = result.json as {
      ok: boolean;
      synced: number;
      total: number;
      bridge_available: boolean;
      results: Array<{ recording_id: number; title: string; status: string }>;
      message: string;
    };
    expect(json.ok).toBe(true);
    expect(json.bridge_available).toBe(false);
    expect(json.total).toBe(mockMeetings.length);
    expect(json.synced).toBe(mockMeetings.length);
    expect(json.results).toHaveLength(mockMeetings.length);
    expect(json.results.every((r) => r.status === 'ok')).toBe(true);
    expect(json.message).toContain('Successfully synced');
  });

  // --- sync-003: max_meetings caps the number of synced meetings ---
  it('max_meetings limits the number of meetings synced', async () => {
    await setup();
    const result = await testClient.callTool('sync_fathom_meetings_to_rebel', {
      max_meetings: 1,
      dry_run: true,
    });
    const json = result.json as { would_sync: number; meetings: Array<unknown> };
    expect(json.would_sync).toBe(1);
    expect(json.meetings).toHaveLength(1);
  });

  // --- sync-004: since filter is passed as created_after to Fathom API ---
  it('passes since parameter as created_after query param', async () => {
    let capturedUrl = '';
    mswServer.use(
      http.get('https://api.fathom.ai/external/v1/meetings', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ limit: 25, next_cursor: null, items: [] });
      }),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    await testClient.callTool('sync_fathom_meetings_to_rebel', {
      since: '2026-01-01',
      dry_run: true,
    });
    expect(capturedUrl).toContain('created_after=2026-01-01');
  });

  // --- sync-005: returns empty result when no meetings found ---
  it('returns ok with synced=0 when no meetings exist', async () => {
    mswServer.use(
      http.get('https://api.fathom.ai/external/v1/meetings', () =>
        HttpResponse.json({ limit: 25, next_cursor: null, items: [] }),
      ),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    const result = await testClient.callTool('sync_fathom_meetings_to_rebel', {});
    const json = result.json as { ok: boolean; synced: number; message: string };
    expect(json.ok).toBe(true);
    expect(json.synced).toBe(0);
    expect(json.message).toContain('No meetings found');
  });

  // --- sync-006: no API key returns descriptive error ---
  it('returns error when API key is not configured', async () => {
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });
    const result = await testClient.callTool('sync_fathom_meetings_to_rebel', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('API key not configured');
  });

  // --- sync-007: sync_fathom_meetings_to_rebel appears in tool list ---
  it('sync_fathom_meetings_to_rebel is registered', async () => {
    await setup();
    const tools = await testClient.listTools();
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('sync_fathom_meetings_to_rebel');
  });
});
