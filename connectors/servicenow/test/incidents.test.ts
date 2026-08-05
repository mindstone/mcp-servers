import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createServiceNowHandlers,
  createServiceNowUnauthorizedHandlers,
  createServiceNowTimeoutHandlers,
  createServiceNowRateLimitHandlers,
} from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const TEST_ENV = {
  SERVICENOW_INSTANCE: 'test-instance',
  SERVICENOW_USERNAME: 'test-user',
  SERVICENOW_PASSWORD: 'test-pass',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('ServiceNow incident tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── list_servicenow_incidents ─────────────────────────────────

  it('list_servicenow_incidents returns incidents', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    const json = result.json as { ok: boolean; incidents: Array<{ number: string }>; count: number };
    expect(json.ok).toBe(true);
    expect(json.incidents).toHaveLength(2);
    expect(json.incidents[0].number).toBe('INC0010001');
    expect(json.count).toBe(2);
  });

  // ── get_servicenow_incident ───────────────────────────────────

  it('get_servicenow_incident by number returns incident', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_incident', {
      identifier: 'INC0010001',
    });
    const json = result.json as { ok: boolean; incident: { number: string; short_description: string } };
    expect(json.ok).toBe(true);
    expect(json.incident.number).toBe('INC0010001');
    // Free-text fields arrive in the untrusted-content envelope (invariant #6)
    expect(json.incident.short_description).toBe(
      '<untrusted-content source="servicenow:incident:short_description">VPN not connecting</untrusted-content>',
    );
  });

  it('get_servicenow_incident by sys_id returns incident', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_incident', {
      identifier: 'inc-sys-id-001',
    });
    const json = result.json as { ok: boolean; incident: { sys_id: string } };
    expect(json.ok).toBe(true);
    expect(json.incident.sys_id).toBe('inc-sys-id-001');
  });

  it('get_servicenow_incident with nonexistent number returns not found', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_incident', {
      identifier: 'INC9999999',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not found');
  });

  // ── create_servicenow_incident ────────────────────────────────

  it('create_servicenow_incident returns created incident with number and sys_id', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('create_servicenow_incident', {
      short_description: 'Test incident',
      urgency: '2',
      impact: '2',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      incident: { number: string; sys_id: string };
    };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Incident created.');
    expect(json.incident.number).toBe('INC0010099');
    expect(json.incident.sys_id).toBe('new-incident-sys-id');
  });

  it('create_servicenow_incident rejects empty short_description via Zod', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('create_servicenow_incident', {
      short_description: '',
    });
    expect(result.isError).toBe(true);
  });

  // ── update_servicenow_incident ────────────────────────────────

  it('update_servicenow_incident updates and returns incident', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('update_servicenow_incident', {
      sys_id: 'inc-sys-id-001',
      state: '2',
      assigned_to: 'jane.doe',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      incident: { state: string; assigned_to: string };
    };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Incident updated.');
    expect(json.incident.state).toBe('2');
    expect(json.incident.assigned_to).toBe(
      '<untrusted-content source="servicenow:incident:assigned_to">jane.doe</untrusted-content>',
    );
  });

  it('update_servicenow_incident appends work_notes and comments journal fields', async () => {
    let capturedBody: Record<string, string> = {};
    mswServer.use(
      http.patch(
        'https://test-instance.service-now.com/api/now/table/incident/:sysId',
        async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({
            result: { sys_id: 'inc-sys-id-001', ...capturedBody },
          });
        },
      ),
    );
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('update_servicenow_incident', {
      sys_id: 'inc-sys-id-001',
      work_notes: 'Investigating the network switch.',
      comments: 'We are looking into this now.',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      incident: { work_notes: string; comments: string };
    };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Incident updated.');
    // Journal fields reach the API verbatim...
    expect(capturedBody.work_notes).toBe('Investigating the network switch.');
    expect(capturedBody.comments).toBe('We are looking into this now.');
    // ...and are enveloped when echoed back (invariant #6).
    expect(json.incident.work_notes).toBe(
      '<untrusted-content source="servicenow:incident:work_notes">Investigating the network switch.</untrusted-content>',
    );
    expect(json.incident.comments).toBe(
      '<untrusted-content source="servicenow:incident:comments">We are looking into this now.</untrusted-content>',
    );
  });

  // ── Basic auth header ─────────────────────────────────────────

  it('sends correct Basic auth header (base64 username:password)', async () => {
    let capturedAuthHeader = '';

    mswServer.use(
      http.get(
        'https://test-instance.service-now.com/api/now/table/incident',
        ({ request }) => {
          capturedAuthHeader = request.headers.get('Authorization') || '';
          return HttpResponse.json({ result: [] });
        },
      ),
    );

    testClient = await createTestClient({ env: TEST_ENV });
    await testClient.callTool('list_servicenow_incidents', {});

    const expected =
      'Basic ' + Buffer.from('test-user:test-pass').toString('base64');
    expect(capturedAuthHeader).toBe(expected);
  });

  // ── Error handling ────────────────────────────────────────────

  it('invalid credentials return isError without leaking secrets', async () => {
    mswServer.use(...createServiceNowUnauthorizedHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);

    const text = result.text;
    // Must not contain the password
    expect(text).not.toContain('test-pass');
    // Must not contain the base64-encoded credentials
    expect(text).not.toContain(Buffer.from('test-user:test-pass').toString('base64'));
    // Should mention auth failure
    expect(text).toContain('Authentication failed');
  });

  it('timeout returns actionable error without secrets', async () => {
    mswServer.use(...createServiceNowTimeoutHandlers());

    testClient = await createTestClient({
      env: TEST_ENV,
    });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);

    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('TIMEOUT');
    expect(json.error).toContain('timed out');
    // Must not contain secrets
    expect(result.text).not.toContain('test-pass');
  }, 45_000);

  it('rate limit returns actionable error', async () => {
    mswServer.use(...createServiceNowRateLimitHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);

    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('RATE_LIMITED');
    expect(json.error).toContain('Rate limited');
  });

  it('malformed input rejected by Zod before outbound request', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(
        'https://test-instance.service-now.com/api/now/table/incident',
        () => {
          requestCount++;
          return HttpResponse.json({ result: [] });
        },
      ),
    );

    testClient = await createTestClient({ env: TEST_ENV });

    // get_servicenow_incident requires identifier (min 1 char)
    const result = await testClient.callTool('get_servicenow_incident', {
      identifier: '',
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0); // No HTTP request should have been made
  });
});
