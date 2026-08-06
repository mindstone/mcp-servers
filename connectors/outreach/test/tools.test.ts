import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createOutreachHandlers, MOCK_ACCESS_TOKEN } from './helpers/outreach-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';

function setupAuth() {
  return createTempConfig({
    accounts: [
      {
        id: 'test-user',
        username: 'test@example.com',
        connected_at: new Date().toISOString(),
      },
    ],
    credentials: [
      {
        filename: 'test-user.token.json',
        data: {
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'mock-refresh',
          expires_at: Date.now() + 3600_000,
          scope: 'prospects.all',
          created_at: Date.now(),
          username: 'test@example.com',
        },
      },
    ],
  });
}

describe('Tool tests — Outreach MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  // --- Prospects ---

  it('outreach_search_prospects returns data via mock API', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_search_prospects', { email: 'jane@acme.com' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
    const records = (result.json as Record<string, unknown>).records as unknown[];
    expect(records.length).toBeGreaterThan(0);
  });

  it('outreach_get_prospect returns prospect details', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_prospect', { id: '101' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('id', '101');
  });

  it('outreach_create_prospect sends correct payload', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_create_prospect', {
      email: 'new@acme.com',
      first_name: 'New',
      last_name: 'Prospect',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'created');
  });

  it('outreach_update_prospect updates a prospect', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_update_prospect', {
      id: '101',
      title: 'CTO',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'updated');
  });

  it('outreach_create_prospect accepts custom1..custom35 fields', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_create_prospect', {
      email: 'new@acme.com',
      last_name: 'Prospect',
      custom_fields: { custom1: 'enterprise', custom35: 42 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    // Custom field values are external text on the way back: enveloped.
    expect((result.json as Record<string, unknown>).custom1).toBe(
      '<untrusted-content source="outreach:prospect:custom1">enterprise</untrusted-content>',
    );
    expect((result.json as Record<string, unknown>).custom35).toBe(42);
  });

  it('outreach_update_prospect rejects custom field keys outside custom1..custom35', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    for (const badKey of ['custom0', 'custom36', 'customField1']) {
      const result = await testClient.callTool('outreach_update_prospect', {
        id: '101',
        custom_fields: { [badKey]: 'x' },
      });
      expect(result.isError, `expected ${badKey} to be rejected`).toBe(true);
      expect(result.json).toHaveProperty('code', 'VALIDATION_ERROR');
    }

    // Boundary keys pass validation (request reaches the mock API).
    const okResult = await testClient.callTool('outreach_update_prospect', {
      id: '101',
      custom_fields: { custom1: 'a', custom35: 'b' },
    });
    expect(okResult.isError).toBeFalsy();
    expect(okResult.json).toHaveProperty('status', 'updated');
  });

  // --- Sequences ---

  it('outreach_list_sequences returns sequences', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_sequences', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });

  it('list tools fall back to records.length when the API omits meta.count', async () => {
    mswServer.use(...createOutreachHandlers());
    mswServer.use(
      http.get(`${OUTREACH_API_BASE}/sequences`, () =>
        HttpResponse.json({
          data: [
            {
              id: '301',
              type: 'sequence',
              attributes: { name: 'Demo Follow-up', enabled: true, sequenceStepCount: 5 },
            },
          ],
          // No meta at all — the vendor omitted the count.
        }),
      ),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_sequences', {});
    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect((json.records as unknown[]).length).toBe(1);
    // Not the misleading 0 the connector used to report.
    expect(json.count).toBe(1);
  });

  it('outreach_add_prospect_to_sequence enrolls prospect', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_add_prospect_to_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'enrolled');
  });

  // --- Sequence content ---

  it('outreach_list_sequence_steps returns steps for a sequence', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_sequence_steps', { sequence_id: '301' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    const records = (result.json as Record<string, unknown>).records as Record<string, unknown>[];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].stepType).toBe('auto_email');
    expect(records[0].sequenceTemplates_ids).toEqual(['901']);
  });

  it('outreach_get_sequence_template resolves the linked template copy', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_sequence_template', { id: '901' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('template_id', '1001');
    const template = (result.json as Record<string, unknown>).template as Record<string, unknown>;
    expect(template).toBeDefined();
    // Email copy is external text: enveloped by formatResource.
    expect(template.subject).toBe(
      '<untrusted-content source="outreach:template:subject">Hello from Acme</untrusted-content>',
    );
    expect(template.bodyHtml).toContain('<untrusted-content source="outreach:template:bodyHtml">');
  });

  it('outreach_get_sequence_template returns structured error for unknown ID', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_sequence_template', { id: '404999' });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'HTTP_404');
  });

  it('rejects non-numeric (path-traversal) IDs before any API request', async () => {
    mswServer.use(...createOutreachHandlers());
    let apiRequests = 0;
    mswServer.use(
      http.all(`${OUTREACH_API_BASE}/*`, () => {
        apiRequests += 1;
        return HttpResponse.json({ data: [] });
      }),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    for (const [tool, args] of [
      ['outreach_get_prospect', { id: '../prospects' }],
      ['outreach_complete_task', { id: '../../tasks' }],
      ['outreach_get_account', { id: '1/../2' }],
      ['outreach_get_sequence_template', { id: 'abc' }],
    ] as const) {
      const result = await testClient.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('numeric');
    }
    // Zod rejected every input up front — nothing reached the vendor API.
    expect(apiRequests).toBe(0);
  });

  it('outreach_get_sequence_template fails closed on a non-numeric template reference from the vendor', async () => {
    mswServer.use(...createOutreachHandlers());
    let templateFetches = 0;
    mswServer.use(
      http.get(`${OUTREACH_API_BASE}/sequenceTemplates/:id`, () =>
        HttpResponse.json({
          data: {
            id: '901',
            type: 'sequenceTemplate',
            attributes: { enabled: true },
            relationships: {
              // Attacker-shaped relationship ID steering the follow-up GET.
              template: { data: { id: '../sequenceStates', type: 'template' } },
            },
          },
        }),
      ),
      http.get(`${OUTREACH_API_BASE}/templates/:id`, () => {
        templateFetches += 1;
        return HttpResponse.json({ data: { id: '1001', type: 'template', attributes: {} } });
      }),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_sequence_template', { id: '901' });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'INVALID_RESPONSE');
    // The steered follow-up request never happened.
    expect(templateFetches).toBe(0);
  });

  it('outreach_remove_prospect_from_sequence pauses by default', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'paused');
    expect(result.json).toHaveProperty('state', 'paused');
  });

  it('outreach_remove_prospect_from_sequence with action "remove" finishes the enrollment', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '101',
      sequence_id: '301',
      action: 'remove',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'removed');
    expect(result.json).toHaveProperty('state', 'finished');
  });

  it('outreach_remove_prospect_from_sequence returns NOT_FOUND when not enrolled', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '999',
      sequence_id: '301',
    });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'NOT_FOUND');
  });

  it('outreach_remove_prospect_from_sequence acts on the live state, not a finished one listed first', async () => {
    mswServer.use(...createOutreachHandlers());
    // Re-enrollment leaves multiple sequenceStates for the same pair, with no
    // API ordering guarantee: finished record first, live one second.
    mswServer.use(
      http.get(`${OUTREACH_API_BASE}/sequenceStates`, () =>
        HttpResponse.json({
          data: [
            {
              id: '702',
              type: 'sequenceState',
              attributes: { state: 'finished' },
              relationships: {
                prospect: { data: { id: '101', type: 'prospect' } },
                sequence: { data: { id: '301', type: 'sequence' } },
              },
            },
            {
              id: '701',
              type: 'sequenceState',
              attributes: { state: 'active' },
              relationships: {
                prospect: { data: { id: '101', type: 'prospect' } },
                sequence: { data: { id: '301', type: 'sequence' } },
              },
            },
          ],
          meta: { count: 2 },
        }),
      ),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    // The live enrollment (701) is paused — not the finished no-op (702).
    expect(result.json).toHaveProperty('sequence_state_id', '701');
    expect(result.json).toHaveProperty('state', 'paused');
  });

  it('outreach_remove_prospect_from_sequence fails closed on multiple live enrollments', async () => {
    mswServer.use(...createOutreachHandlers());
    mswServer.use(
      http.get(`${OUTREACH_API_BASE}/sequenceStates`, () =>
        HttpResponse.json({
          data: [
            {
              id: '701',
              type: 'sequenceState',
              attributes: { state: 'active' },
              relationships: {
                prospect: { data: { id: '101', type: 'prospect' } },
                sequence: { data: { id: '301', type: 'sequence' } },
              },
            },
            {
              id: '703',
              type: 'sequenceState',
              attributes: { state: 'paused' },
              relationships: {
                prospect: { data: { id: '101', type: 'prospect' } },
                sequence: { data: { id: '301', type: 'sequence' } },
              },
            },
          ],
          meta: { count: 2 },
        }),
      ),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'AMBIGUOUS_STATE');
  });

  it('outreach_remove_prospect_from_sequence returns NOT_FOUND when every enrollment is finished', async () => {
    mswServer.use(...createOutreachHandlers());
    mswServer.use(
      http.get(`${OUTREACH_API_BASE}/sequenceStates`, () =>
        HttpResponse.json({
          data: [
            {
              id: '702',
              type: 'sequenceState',
              attributes: { state: 'finished' },
              relationships: {
                prospect: { data: { id: '101', type: 'prospect' } },
                sequence: { data: { id: '301', type: 'sequence' } },
              },
            },
          ],
          meta: { count: 1 },
        }),
      ),
    );
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_remove_prospect_from_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'NOT_FOUND');
  });

  // --- Accounts ---

  it('outreach_list_accounts returns accounts', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_accounts', { name: 'Acme' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });

  // --- Tasks ---

  it('outreach_list_tasks returns tasks', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_tasks', { status: 'incomplete' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
  });

  it('outreach_create_task creates a task with note, due date, and prospect', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_create_task', {
      note: 'Follow up on pricing question',
      action: 'call',
      due_at: '2026-05-01T17:00:00Z',
      prospect_id: '101',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'created');
    expect(result.json).toHaveProperty('dueAt', '2026-05-01T17:00:00.000Z');
    expect(result.json).toHaveProperty('prospect_id', '101');
    // The note is user-authored text echoed back by the API: enveloped.
    expect((result.json as Record<string, unknown>).note).toBe(
      '<untrusted-content source="outreach:task:note">Follow up on pricing question</untrusted-content>',
    );
  });

  it('outreach_create_task rejects an unparseable due_at', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_create_task', {
      note: 'Call back',
      due_at: 'next Tuesday-ish',
    });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('outreach_complete_task marks a task completed', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_complete_task', { id: '401' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'completed');
    expect(result.json).toHaveProperty('state', 'completed');
  });

  // --- Mailings ---

  it('outreach_list_mailings returns mailings', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_mailings', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
  });

  // --- Calls ---

  it('outreach_list_calls returns calls with disposition link', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_calls', { prospect_id: '101' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    const records = (result.json as Record<string, unknown>).records as Record<string, unknown>[];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].outcome).toBe('completed');
    expect(records[0].callDisposition_id).toBe('1201');
    // Call notes are user-authored: enveloped.
    expect(records[0].note).toBe(
      '<untrusted-content source="outreach:call:note">Discussed renewal timeline</untrusted-content>',
    );
  });

  // --- Mailboxes ---

  it('outreach_list_mailboxes returns mailboxes', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_mailboxes', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    const records = (result.json as Record<string, unknown>).records as Record<string, unknown>[];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].email).toBe(
      '<untrusted-content source="outreach:mailbox:email">john@company.com</untrusted-content>',
    );
    expect(records[0].user_id).toBe('601');
  });

  // --- Users ---

  it('outreach_list_users returns users', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_users', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });
});
