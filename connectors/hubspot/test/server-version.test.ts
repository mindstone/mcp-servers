import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpTestClient,
  type McpTestClient,
  resolveServerScript,
} from './fixtures/mcp-test-harness.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

describe('HubSpot server metadata', () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = await createMcpTestClient({
      name: 'hubspot-version',
      serverScript: resolveServerScript('hubspot'),
      connectTimeout: 15_000,
    });
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it('returns initialize serverInfo.version from package.json', () => {
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it('reports the full 95-tool surface in tools/list', async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(95);
  });
});
