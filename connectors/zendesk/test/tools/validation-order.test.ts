import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';

// Spy on account resolution: getAccount can trigger an OAuth refresh (a
// network call), so invalid tool input must be rejected WITHOUT calling it.
vi.mock('../../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth.js')>();
  return { ...actual, getAccount: vi.fn(actual.getAccount) };
});

describe('Validation order — invalid input is rejected before account resolution', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;
  let getAccountSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const tempConfig = createTempConfig({
      accounts: [API_TOKEN_ACCOUNT],
      defaultAccount: API_TOKEN_ACCOUNT.subdomain,
      prefix: 'zendesk-test-',
    });
    cleanup = tempConfig.cleanup;
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));
    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
    const authModule = await import('../../src/auth.js');
    getAccountSpy = authModule.getAccount as unknown as ReturnType<typeof vi.fn>;
  });

  afterAll(async () => {
    await testClient?.close();
    cleanup?.();
  });

  it('search_zendesk_tickets rejects an empty query without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('search_zendesk_tickets', { query: '' });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Query is required');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('export_zendesk_tickets rejects an empty query without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('export_zendesk_tickets', { query: '' });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Query is required');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('export_zendesk_tickets rejects an invalid output_path without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('export_zendesk_tickets', {
      query: 'status:open',
      save_to_file: true,
      output_path: '/etc/zendesk-export-evil.json',
    });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.code).toBe('INVALID_OUTPUT_PATH');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('export_zendesk_tickets rejects include_comments beyond the cap without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('export_zendesk_tickets', {
      query: 'status:open',
      include_comments: true,
      max_results: 201,
    });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('include_comments');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('get_zendesk_tickets_by_ids rejects an empty ids array at the schema layer without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('get_zendesk_tickets_by_ids', { ids: [] });
    expect(result.isError).toBeTruthy();
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('get_zendesk_tickets_by_ids rejects an invalid output_path without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('get_zendesk_tickets_by_ids', {
      ids: [1],
      save_to_file: true,
      output_path: '/etc/zendesk-byids-evil.json',
    });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.code).toBe('INVALID_OUTPUT_PATH');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('get_zendesk_tickets_by_ids rejects oversized in-context fetches without resolving an account', async () => {
    getAccountSpy.mockClear();
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const result = await testClient.callTool('get_zendesk_tickets_by_ids', { ids });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('in-context');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('create_zendesk_ticket rejects a missing comment without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('create_zendesk_ticket', { subject: 'x', comment: '' });
    const data = result.json as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('subject and comment are required');
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('apply_zendesk_macro rejects a missing macro without resolving an account', async () => {
    getAccountSpy.mockClear();
    const result = await testClient.callTool('apply_zendesk_macro', { ticket_id: 1, macro_id: 0 });
    expect(result.isError).toBeTruthy();
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it('still resolves an account for valid input (spy is wired to the real implementation)', async () => {
    getAccountSpy.mockClear();
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));
    const result = await testClient.callTool('search_zendesk_tickets', { query: 'status:open' });
    expect(result.isError).toBeFalsy();
    expect(getAccountSpy).toHaveBeenCalled();
  });
});
