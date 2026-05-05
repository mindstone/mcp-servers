import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMcpTestClient,
  resolveServerScript,
  type McpTestClient
} from './fixtures/mcp-test-harness.js';

describe('unconfigured mode fallback', () => {
  it('keeps local diagnostics available and returns auth_required for remote tools', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'hubspot-unconfigured-'));
    writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ accounts: [] }));

    let client: McpTestClient | undefined;
    try {
      client = await createMcpTestClient({
        name: 'hubspot-unconfigured-mode',
        serverScript: resolveServerScript('hubspot'),
        env: {
          HUBSPOT_CONFIG_DIR: configDir
        },
        connectTimeout: 15_000
      });

      const listAccounts = await client.callToolJson<{ accounts: unknown[] }>('list_hubspot_accounts');
      expect(Array.isArray(listAccounts.accounts)).toBe(true);
      expect(listAccounts.accounts).toHaveLength(0);

      const remoteToolResult = await client.callToolJson<Record<string, unknown>>('search_hubspot_contacts', {
        query: 'alice'
      });
      expect(remoteToolResult.status).toBe('auth_required');
      expect(remoteToolResult.setupToolName).toBe('authenticate_hubspot_account');
    } finally {
      if (client) {
        await client.close();
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
