import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('Humaans company & location tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    mswServer.use(...createHumaansHandlers(API_KEY));
    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('list_humaans_locations returns location data', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_locations', {});
    const json = result.json as {
      ok: boolean;
      locations: Array<{ id: string; label: string; city: string }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.locations).toHaveLength(2);
    expect(json.locations[0]).toHaveProperty('label');
    expect(json.locations[0]).toHaveProperty('city');
    expect(json.locations[0].label).toBe('London HQ');
  });

  it('get_humaans_company returns company info', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_company', {});
    const json = result.json as {
      ok: boolean;
      company: { id: string; name: string; status: string };
    };

    expect(json.ok).toBe(true);
    expect(json.company).toHaveProperty('name');
    expect(json.company.name).toBe('Acme Corp');
    expect(json.company.status).toBe('active');
  });

  it('list_humaans_job_roles returns job role history', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_job_roles', {});
    const json = result.json as {
      ok: boolean;
      jobRoles: Array<{ id: string; jobTitle: string; department: string }>;
      count: number;
      total: number;
    };

    expect(json.ok).toBe(true);
    expect(json.jobRoles).toHaveLength(2);
    expect(json.jobRoles[0].jobTitle).toBe('Senior Engineer');
    expect(json.jobRoles[0].department).toBe('Engineering');
  });

  it('get_humaans_job_role returns a specific job role', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_job_role', { jobRoleId: 'role-001' });
    const json = result.json as {
      ok: boolean;
      jobRole: { id: string; jobTitle: string; effectiveDate: string };
    };

    expect(json.ok).toBe(true);
    expect(json.jobRole.id).toBe('role-001');
    expect(json.jobRole.jobTitle).toBe('Senior Engineer');
    expect(json.jobRole.effectiveDate).toBe('2024-01-01');
  });

  it('get_humaans_job_role returns error for non-existent role', async () => {
    await setup();
    const result = await testClient.callTool('get_humaans_job_role', { jobRoleId: 'non-existent' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });
});
