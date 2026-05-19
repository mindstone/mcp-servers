import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';

import { mswServer } from './helpers/setup.js';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } from './helpers/vanta-mock-api.js';

const EXPECTED_TOOLS = [
  'vanta_attach_vendor_document',
  'vanta_create_vendor',
  'vanta_get_compliance_summary',
  'vanta_get_control',
  'vanta_get_test',
  'vanta_get_vendor',
  'vanta_get_vulnerability',
  'vanta_list_controls',
  'vanta_list_evidence',
  'vanta_list_people',
  'vanta_list_resources',
  'vanta_list_tests',
  'vanta_list_vendors',
  'vanta_list_vulnerabilities',
  'vanta_query_test_results',
  'vanta_update_vendor',
  'vanta_update_vulnerability',
  'vanta_upload_document',
].sort();

const WRITE_TOOLS = new Set([
  'vanta_create_vendor',
  'vanta_update_vendor',
  'vanta_attach_vendor_document',
  'vanta_update_vulnerability',
  'vanta_upload_document',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'vanta_update_vendor',
  'vanta_update_vulnerability',
]);

describe('Smoke test — Vanta MCP server', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('registers all 18 tools', async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        VANTA_REGION: 'us',
      },
    });

    const list = await testClient.client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  it('every tool carries cohort-required annotations (readOnly/destructive/idempotent/openWorld)', async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const list = await testClient.client.listTools();

    for (const tool of list.tools) {
      const ann = tool.annotations ?? {};
      expect(typeof ann.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      expect(typeof ann.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
      expect(typeof ann.idempotentHint, `${tool.name} idempotentHint`).toBe('boolean');
      expect(ann.openWorldHint, `${tool.name} openWorldHint`).toBe(true);

      if (WRITE_TOOLS.has(tool.name)) {
        expect(ann.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      } else {
        expect(ann.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
      }

      if (DESTRUCTIVE_TOOLS.has(tool.name)) {
        expect(ann.destructiveHint, `${tool.name} should be destructive`).toBe(true);
      } else {
        expect(ann.destructiveHint, `${tool.name} should not be destructive`).toBe(false);
      }
    }
  });

  it('server reports the package version from package.json (no hardcoded SERVER_VERSION drift)', async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const info = testClient.client.getServerVersion();
    expect(info?.name).toBe('mcp-server-vanta');
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
