import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers, createFathomUnauthorizedHandlers, createFathomTimeoutHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';

describe('Fathom meetings tools', () => {
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

  // --- VAL-B1-FATHOM-002: X-Api-Key header ---
  it('sends X-Api-Key header on all API requests', async () => {
    let capturedHeaders: Record<string, string | null> = {};
    mswServer.use(
      http.get('https://api.fathom.ai/external/v1/meetings', ({ request }) => {
        capturedHeaders = {
          'X-Api-Key': request.headers.get('X-Api-Key'),
        };
        return HttpResponse.json({
          limit: 25,
          next_cursor: null,
          items: [],
        });
      }),
    );

    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('list_fathom_meetings', {});
    expect(capturedHeaders['X-Api-Key']).toBe(API_KEY);
  });

  // --- VAL-B1-FATHOM-003: list_fathom_meetings returns structured data ---
  it('list_fathom_meetings returns structured meeting data', async () => {
    await setup();
    const result = await testClient.callTool('list_fathom_meetings', {});
    const json = result.json as {
      ok: boolean;
      meetings: Array<{ recording_id: number; title: string; created_at: string }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.meetings).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.meetings[0]).toHaveProperty('recording_id');
    expect(json.meetings[0]).toHaveProperty('title');
    expect(json.meetings[0]).toHaveProperty('created_at');
  });

  it('get_fathom_meeting returns meeting details with summary', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_meeting', { recording_id: 101 });
    const json = result.json as {
      ok: boolean;
      meeting: {
        title: string;
        recording_id: number;
        calendar_invitees: Array<{ name: string; email: string }>;
        summary: { template_name: string; markdown_formatted: string } | null;
      };
    };

    expect(json.ok).toBe(true);
    expect(json.meeting.title).toBe('Weekly Standup');
    expect(json.meeting.recording_id).toBe(101);
    expect(json.meeting.calendar_invitees).toHaveLength(2);
    expect(json.meeting.summary).toBeDefined();
    expect(json.meeting.summary?.markdown_formatted).toContain('Summary');
  });

  it('get_fathom_meeting returns error for non-existent meeting', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_meeting', { recording_id: 999 });
    const json = result.json as { ok: boolean; error: string };

    expect(json.ok).toBe(false);
    expect(json.error).toContain('not found');
  });

  it('get_fathom_transcript returns text format', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_transcript', {
      recording_id: 101,
    });

    expect(result.text).toContain('Alice');
    expect(result.text).toContain('Good morning everyone');
    expect(result.text).toContain('Bob');
  });

  it('get_fathom_transcript returns json format', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_transcript', {
      recording_id: 101,
      format: 'json',
    });
    const json = result.json as {
      ok: boolean;
      transcript: Array<{ text: string; speaker: { name: string } }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.transcript).toHaveLength(3);
    expect(json.count).toBe(3);
  });

  it('get_fathom_transcript search_query filters and returns context', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_transcript', {
      recording_id: 101,
      format: 'json',
      search_query: 'morning',
    });
    const json = result.json as {
      ok: boolean;
      transcript: Array<{ text: string }>;
      searchQuery: string;
      directMatches: number;
    };

    expect(json.ok).toBe(true);
    expect(json.searchQuery).toBe('morning');
    expect(json.directMatches).toBe(2); // "Good morning" and "Morning!"
  });

  // --- VAL-COMMON-003: Invalid credentials fail cleanly without leaking secrets ---
  it('invalid credentials return isError without leaking secrets', async () => {
    mswServer.use(...createFathomUnauthorizedHandlers());

    testClient = await createTestClient({
      env: { FATHOM_API_KEY: 'secret-bad-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_fathom_meetings', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };

    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    // Must not leak the secret key
    expect(result.text).not.toContain('secret-bad-key-12345');
  });

  // --- VAL-COMMON-004: Zod rejects malformed input before outbound request ---
  it('rejects malformed recording_id before making API request', async () => {
    let requestMade = false;
    mswServer.use(
      http.get('https://api.fathom.ai/external/v1/*', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Zod schema requires recording_id to be a positive integer
    const result = await testClient.callTool('get_fathom_meeting', { recording_id: -1 });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  // --- VAL-COMMON-005: Network timeout returns actionable MCP error ---
  it('network timeout returns actionable MCP error', async () => {
    mswServer.use(...createFathomTimeoutHandlers());

    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_fathom_meetings', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('TIMEOUT');
    expect(json.error).toContain('timed out');
    // Must not contain secrets
    expect(result.text).not.toContain(API_KEY);
  }, 45_000);

  // --- Not configured ---
  it('returns not-configured error when no API key is set', async () => {
    mswServer.use(...createFathomHandlers());
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_fathom_meetings', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});
