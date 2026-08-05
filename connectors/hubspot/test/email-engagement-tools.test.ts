/**
 * Email engagement read tools (search/get_hubspot_email) — happy path, and the
 * sales-email-read redaction warning: HubSpot silently empties email bodies
 * when the connected app lacks the scope, so the connector introspects the
 * token (memoised per access token) and attaches a model-visible `notes`
 * warning both when the scope is definitively absent and when the check is
 * inconclusive — no silent degradation in either direction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type MockRoute,
  type McpTestClient,
  type MockApiServer,
} from './fixtures/mcp-test-harness.js';
import { engagementTools } from '../src/tools/definitions.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-emails-test-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email: 'test@example.com', hubId: 12345678 }] })
  );
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'fake-access-token-for-testing',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86400000 * 365,
      hub_id: 12345678,
      user: 'test@example.com',
    })
  );
  return configDir;
}

const EMAIL = {
  id: 'email-1',
  properties: {
    hs_email_subject: 'Re: Q3 contract',
    hs_email_direction: 'INCOMING_EMAIL',
    hs_email_text: '', // redacted by HubSpot without sales-email-read
    hs_timestamp: '1770000000000',
  },
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
  archived: false,
};

const INTROSPECTION_PATH = '/oauth/v1/access-tokens/fake-access-token-for-testing';

function emailRoutes(scopes: string[]): MockRoute[] {
  return [
    {
      method: 'POST' as const,
      path: '/crm/v3/objects/emails/search',
      handler: () => ({ body: { results: [EMAIL] } }),
    },
    {
      method: 'GET' as const,
      path: '/crm/v3/objects/emails/email-1',
      handler: () => ({ body: EMAIL }),
    },
    {
      method: 'GET' as const,
      path: INTROSPECTION_PATH,
      handler: () => ({
        body: { user: 'test@example.com', hub_id: 12345678, user_id: 1001, scopes },
      }),
    },
  ];
}

/** Same email object routes, with a failing/introspection-degraded token endpoint. */
function emailRoutesWithIntrospection(introspection: MockRoute['handler']): MockRoute[] {
  return [
    ...emailRoutes(['oauth']).filter((r) => r.path !== INTROSPECTION_PATH),
    { method: 'GET' as const, path: INTROSPECTION_PATH, handler: introspection },
  ];
}

async function startClient(routes: MockRoute[], configDir: string) {
  return createMcpTestClientWithMockApi({
    name: 'hubspot-emails',
    serverScript: resolveServerScript('hubspot'),
    interceptDomains: ['api.hubapi.com'],
    routes,
    env: {
      HUBSPOT_CONFIG_DIR: configDir,
      HUBSPOT_CLIENT_ID: 'fake-client-id',
      HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
      HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
    },
    connectTimeout: 15_000,
  });
}

describe('HubSpot MCP - email engagement tools', () => {
  it('registers search/get email tools as read-only with the scope note documented', () => {
    const find = (name: string) => engagementTools.find((t) => t.name === name);
    for (const name of ['search_hubspot_emails', 'get_hubspot_email']) {
      const tool = find(name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.description).toContain('sales-email-read');
    }
  });

  describe('without sales-email-read on the token', () => {
    let client: McpTestClient;
    let mockApi: MockApiServer;
    let configDir: string;

    beforeAll(async () => {
      configDir = createHubSpotConfigDir();
      const result = await startClient(emailRoutes(['oauth', 'crm.objects.contacts.read']), configDir);
      client = result.client;
      mockApi = result.mockApi;
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await mockApi?.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it('search_hubspot_emails returns results with a redaction warning attached', async () => {
      const result = await client.callToolJson<{
        results: Array<{ id: string; properties: Record<string, string> }>;
        notes?: string[];
      }>('search_hubspot_emails', { limit: 5 });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('email-1');
      expect(result.results[0].properties.hs_email_subject).toBe(
        '<untrusted-content source="hubspot:engagements/emails">Re: Q3 contract</untrusted-content>'
      );
      expect(result.notes).toBeDefined();
      expect(result.notes![0]).toContain('sales-email-read');
    });

    it('get_hubspot_email carries the same warning', async () => {
      const result = await client.callToolJson<{
        id: string;
        notes?: string[];
      }>('get_hubspot_email', { emailId: 'email-1' });

      expect(result.id).toBe('email-1');
      expect(result.notes?.[0]).toContain('sales-email-read');
    });
  });

  describe('with sales-email-read on the token', () => {
    let client: McpTestClient;
    let mockApi: MockApiServer;
    let configDir: string;

    beforeAll(async () => {
      configDir = createHubSpotConfigDir();
      const result = await startClient(emailRoutes(['oauth', 'crm.objects.contacts.read', 'sales-email-read']), configDir);
      client = result.client;
      mockApi = result.mockApi;
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await mockApi?.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it('attaches no redaction warning when the scope is granted', async () => {
      const result = await client.callToolJson<{
        results: Array<{ id: string }>;
        notes?: string[];
      }>('search_hubspot_emails', { limit: 5 });

      expect(result.results).toHaveLength(1);
      expect(result.notes).toBeUndefined();
    });
  });

  describe('when token introspection fails', () => {
    let client: McpTestClient;
    let mockApi: MockApiServer;
    let configDir: string;

    beforeAll(async () => {
      configDir = createHubSpotConfigDir();
      const result = await startClient(
        emailRoutesWithIntrospection(() => ({ status: 500, body: { message: 'introspection down' } })),
        configDir,
      );
      client = result.client;
      mockApi = result.mockApi;
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await mockApi?.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it('attaches an unverified warning instead of degrading silently', async () => {
      const result = await client.callToolJson<{
        results: Array<{ id: string }>;
        notes?: string[];
      }>('search_hubspot_emails', { limit: 5 });

      expect(result.results).toHaveLength(1);
      expect(result.notes).toBeDefined();
      expect(result.notes![0]).toContain('Could not verify');
      expect(result.notes![0]).toContain('sales-email-read');
    });
  });

  describe('when introspection omits the scope list', () => {
    let client: McpTestClient;
    let mockApi: MockApiServer;
    let configDir: string;

    beforeAll(async () => {
      configDir = createHubSpotConfigDir();
      const result = await startClient(
        emailRoutesWithIntrospection(() => ({
          body: { user: 'test@example.com', hub_id: 12345678, user_id: 1001 },
        })),
        configDir,
      );
      client = result.client;
      mockApi = result.mockApi;
    }, 30_000);

    afterAll(async () => {
      await client?.close();
      await mockApi?.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it('attaches the same unverified warning', async () => {
      const result = await client.callToolJson<{
        id: string;
        notes?: string[];
      }>('get_hubspot_email', { emailId: 'email-1' });

      expect(result.id).toBe('email-1');
      expect(result.notes?.[0]).toContain('Could not verify');
    });
  });
});
